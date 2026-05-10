import { createServer } from "node:http";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildDotUpdatePrompt } from "./codexPrompt.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HOST = "127.0.0.1";
const PORT = Number.parseInt(process.env.PORT || "5173", 10);
const MAX_BODY_BYTES = 240_000;
const CODEX_TIMEOUT_MS = 120_000;
const REASONING_EFFORTS = new Set(["low", "medium", "high", "xhigh"]);
const RENDER_ENGINES = new Set(["default", "dot2tex", "math-svg"]);
const MATH_SVG_CACHE_DIR = path.join(tmpdir(), "graphviz-math-svg-cache-v1");
const MATH_SVG_WORKERS = Math.max(
  1,
  Math.min(4, Number.parseInt(process.env.MATH_SVG_WORKERS || "", 10) || Math.max(1, availableParallelism() - 1)),
);
const RENDER_CACHE_LIMIT = 24;
const FORMULA_CACHE_VERSION = 1;

const formulaImageJobs = new Map();
const renderJobs = new Map();
const renderCache = new Map();

const STATIC_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
]);

const STATIC_FILES = new Set(["/index.html", "/styles.css", "/app.js"]);

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

function sendBinary(response, statusCode, body, contentType, filename) {
  response.writeHead(statusCode, {
    "content-type": contentType,
    "content-length": body.length,
    "content-disposition": `attachment; filename="${filename}"`,
    "cache-control": "no-store",
  });
  response.end(body);
}

function isLocalRequest(request) {
  const remote = request.socket.remoteAddress;
  return remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
}

async function readJsonBody(request) {
  let size = 0;
  const chunks = [];

  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error("Request body is too large.");
    }
    chunks.push(chunk);
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function validateDotRequest(payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("Request JSON must be an object.");
  }

  const { dotSource, instruction, reasoningEffort = "medium", renderEngine = "default", context = [] } = payload;
  if (typeof dotSource !== "string" || typeof instruction !== "string") {
    throw new Error("dotSource and instruction must be strings.");
  }

  if (typeof reasoningEffort !== "string" || !REASONING_EFFORTS.has(reasoningEffort)) {
    throw new Error("Invalid reasoning effort.");
  }

  if (typeof renderEngine !== "string" || !RENDER_ENGINES.has(renderEngine)) {
    throw new Error("Invalid render engine.");
  }

  if (!Array.isArray(context)) {
    throw new Error("context must be an array.");
  }

  if (!instruction.trim()) {
    throw new Error("Instruction is empty.");
  }

  if (dotSource.length > 180_000) {
    throw new Error("dotSource is too large.");
  }

  if (instruction.length > 12_000) {
    throw new Error("Instruction is too large.");
  }

  if (JSON.stringify(context).length > 90_000) {
    throw new Error("Context is too large.");
  }
}

function validateRenderRequest(payload) {
  if (!payload || typeof payload !== "object" || typeof payload.dotSource !== "string") {
    throw new Error("dotSource must be a string.");
  }

  if (payload.dotSource.length > 180_000) {
    throw new Error("dotSource is too large.");
  }
}

function validateExportPdfRequest(payload) {
  validateRenderRequest(payload);

  if (typeof payload.renderEngine !== "string" || !RENDER_ENGINES.has(payload.renderEngine)) {
    throw new Error("Invalid render engine.");
  }
}

function getRequestAbortSignal(request, response) {
  const controller = new AbortController();
  request.on("aborted", () => {
    controller.abort();
  });
  response.on("close", () => {
    if (!response.writableEnded) {
      controller.abort();
    }
  });
  return controller.signal;
}

function normalizeContext(context) {
  return context.slice(-12).map((item) => ({
    user: typeof item?.user === "string" ? item.user.slice(0, 12_000) : "",
    response: typeof item?.response === "string" ? item.response.slice(0, 8_000) : "",
    patch: typeof item?.patch === "string" ? item.patch.slice(0, 30_000) : "",
    decision: ["apply", "cancel", "no_suggestion", "interrupted", "error"].includes(item?.decision)
      ? item.decision
      : "unknown",
  }));
}

async function runCommand(command, args, { cwd, timeoutMs = 60_000, abortSignal, encoding = "utf8" } = {}) {
  return await new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks = [];
    const stderrChunks = [];

    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      abortSignal?.removeEventListener("abort", abortCommand);
      if (error) {
        reject(error);
        return;
      }
      const stdoutBuffer = Buffer.concat(stdoutChunks);
      const stderrBuffer = Buffer.concat(stderrChunks);
      resolve({
        stdout: encoding === "buffer" ? stdoutBuffer : stdoutBuffer.toString(encoding),
        stderr: stderrBuffer.toString("utf8"),
      });
    }

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error(`${command} timed out.`));
    }, timeoutMs);

    function abortCommand() {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, 1500);
      finish(new Error(`${command} was interrupted.`));
    }

    if (abortSignal?.aborted) {
      abortCommand();
      return;
    }

    abortSignal?.addEventListener("abort", abortCommand, { once: true });

    child.stdout.on("data", (chunk) => {
      stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrChunks.push(chunk);
    });
    child.on("error", (error) => {
      if (error.code === "ENOENT") {
        finish(new Error(`${command} is not installed or is not in PATH.`));
        return;
      }
      finish(error);
    });
    child.on("close", (code) => {
      if (code === 0) {
        finish();
        return;
      }
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      finish(new Error(`${command} exited with ${code}.\n${stderr || stdout}`.trim()));
    });
  });
}

function hashValue(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function fileExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function isPathInside(childPath, parentPath) {
  const relative = path.relative(parentPath, childPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

function rememberRenderResult(key, svg) {
  if (renderCache.has(key)) {
    renderCache.delete(key);
  }
  renderCache.set(key, svg);

  while (renderCache.size > RENDER_CACHE_LIMIT) {
    const oldestKey = renderCache.keys().next().value;
    renderCache.delete(oldestKey);
  }
}

async function renderWithCache(engine, dotSource, renderer, abortSignal) {
  const key = `${engine}:${hashValue(dotSource)}`;
  if (renderCache.has(key)) {
    const cached = renderCache.get(key);
    rememberRenderResult(key, cached);
    return cached;
  }

  if (renderJobs.has(key)) {
    return await renderJobs.get(key);
  }

  const job = renderer(dotSource, abortSignal).then((svg) => {
    rememberRenderResult(key, svg);
    return svg;
  });
  renderJobs.set(key, job);

  try {
    return await job;
  } finally {
    renderJobs.delete(key);
  }
}

function normalizeDot2TexMath(dotSource) {
  return dotSource.replace(/\$\$([\s\S]*?)\$\$/g, (_match, expression) => `$${expression}$`);
}

function escapeHtml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function unescapeDotString(value) {
  return value.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

function isEscaped(value, index) {
  let slashCount = 0;
  for (let i = index - 1; i >= 0 && value[i] === "\\"; i -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

function findClosingDollar(value, start, delimiter) {
  for (let i = start; i < value.length; i += 1) {
    if (isEscaped(value, i)) continue;
    if (delimiter === "$$" && value.startsWith("$$", i)) return i;
    if (delimiter === "$" && value[i] === "$") return i;
  }
  return -1;
}

function parseMathLabelParts(label) {
  const parts = [];
  let lastIndex = 0;
  let index = 0;

  while (index < label.length) {
    if (label[index] !== "$" || isEscaped(label, index)) {
      index += 1;
      continue;
    }

    const delimiter = label.startsWith("$$", index) ? "$$" : "$";
    const expressionStart = index + delimiter.length;
    const expressionEnd = findClosingDollar(label, expressionStart, delimiter);
    if (expressionEnd === -1) {
      index += delimiter.length;
      continue;
    }

    if (index > lastIndex) {
      parts.push({ type: "text", value: label.slice(lastIndex, index) });
    }
    parts.push({ type: "math", value: label.slice(expressionStart, expressionEnd) });
    index = expressionEnd + delimiter.length;
    lastIndex = index;
  }

  if (lastIndex < label.length) {
    parts.push({ type: "text", value: label.slice(lastIndex) });
  }

  return parts;
}

function getFormulaCachePaths(expression) {
  const key = hashValue(JSON.stringify({ version: FORMULA_CACHE_VERSION, expression }));
  return {
    key,
    svgPath: path.join(MATH_SVG_CACHE_DIR, `${key}.svg`),
    pngPath: path.join(MATH_SVG_CACHE_DIR, `${key}.png`),
  };
}

async function generateFormulaImage(expression, paths, abortSignal) {
  const tempDir = await mkdtemp(path.join(tmpdir(), "graphviz-formula-"));
  const baseName = "formula";
  const texPath = path.join(tempDir, `${baseName}.tex`);
  const svgPath = path.join(tempDir, `${baseName}.svg`);
  const pngPath = path.join(tempDir, `${baseName}.png`);
  const tex = `\\documentclass{standalone}
\\usepackage{amsmath,amssymb}
\\begin{document}
$${expression}$
\\end{document}
`;

  try {
    await writeFile(texPath, tex, "utf8");
    await runCommand("pdflatex", ["-no-shell-escape", "-interaction=nonstopmode", "-halt-on-error", `${baseName}.tex`], {
      abortSignal,
      cwd: tempDir,
      timeoutMs: 60_000,
    });
    await runCommand("dvisvgm", ["--pdf", "--no-fonts", `--output=${baseName}.svg`, `${baseName}.pdf`], {
      abortSignal,
      cwd: tempDir,
      timeoutMs: 60_000,
    });
    await runCommand("inkscape", [svgPath, "--export-type=png", `--export-filename=${pngPath}`], {
      abortSignal,
      cwd: tempDir,
      timeoutMs: 60_000,
    });

    await mkdir(MATH_SVG_CACHE_DIR, { recursive: true });
    await copyFile(svgPath, paths.svgPath);
    await copyFile(pngPath, paths.pngPath);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }

  return paths;
}

async function makeFormulaImage(expression, abortSignal) {
  const trimmed = expression.trim();
  const paths = getFormulaCachePaths(trimmed);
  if ((await fileExists(paths.svgPath)) && (await fileExists(paths.pngPath))) {
    return paths;
  }

  if (formulaImageJobs.has(paths.key)) {
    return await formulaImageJobs.get(paths.key);
  }

  const job = generateFormulaImage(trimmed, paths, abortSignal);
  formulaImageJobs.set(paths.key, job);

  try {
    return await job;
  } finally {
    formulaImageJobs.delete(paths.key);
  }
}

async function buildMathImageDot(dotSource, abortSignal) {
  const attributePattern = /\b([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"((?:\\.|[^"\\])*)"/g;
  const replacements = [];
  const uniqueExpressions = new Map();
  let nextReadIndex = 0;
  let output = "";
  let match;

  while ((match = attributePattern.exec(dotSource))) {
    const attributeName = match[1];
    const rawValue = match[2];
    if (!/label$/i.test(attributeName)) {
      continue;
    }

    const label = unescapeDotString(rawValue);
    const parts = parseMathLabelParts(label);
    if (!parts.some((part) => part.type === "math")) {
      continue;
    }

    for (const part of parts) {
      if (part.type === "math") {
        const expression = part.value.trim();
        if (expression) {
          uniqueExpressions.set(expression, null);
        }
      }
    }

    replacements.push({
      attributeName,
      end: attributePattern.lastIndex,
      parts,
      start: match.index,
    });
  }

  const expressions = [...uniqueExpressions.keys()];
  const images = await mapWithConcurrency(expressions, MATH_SVG_WORKERS, async (expression) => {
    return await makeFormulaImage(expression, abortSignal);
  });
  expressions.forEach((expression, index) => {
    uniqueExpressions.set(expression, images[index]);
  });

  for (const replacement of replacements) {
    output += dotSource.slice(nextReadIndex, replacement.start);
    const cells = [];
    for (const part of replacement.parts) {
      if (part.type === "math") {
        const image = uniqueExpressions.get(part.value.trim());
        if (!image) continue;
        cells.push(`<TD><IMG SRC="${escapeHtml(image.pngPath)}"/></TD>`);
      } else if (part.value) {
        for (const line of part.value.split("\n")) {
          if (line) {
            cells.push(`<TD>${escapeHtml(line)}</TD>`);
          }
        }
      }
    }

    output += `${replacement.attributeName}=<<TABLE BORDER="0" CELLBORDER="0" CELLSPACING="0"><TR>${cells.join("")}</TR></TABLE>>`;
    nextReadIndex = replacement.end;
  }

  output += dotSource.slice(nextReadIndex);
  return output;
}

function getXmlAttribute(tag, name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`\\b${escapedName}\\s*=\\s*(["'])(.*?)\\1`);
  return tag.match(pattern)?.[2] || "";
}

function parseSvgLength(value) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseFormulaSvg(svgText) {
  const root = svgText.match(/<svg\b([^>]*)>([\s\S]*?)<\/svg>/i);
  if (!root) {
    throw new Error("Formula renderer returned invalid SVG.");
  }

  const rootAttributes = root[1];
  const viewBox = getXmlAttribute(rootAttributes, "viewBox")
    .trim()
    .split(/\s+/)
    .map(Number.parseFloat);
  const width = parseSvgLength(getXmlAttribute(rootAttributes, "width"));
  const height = parseSvgLength(getXmlAttribute(rootAttributes, "height"));
  const [viewBoxX, viewBoxY, viewBoxWidth, viewBoxHeight] =
    viewBox.length === 4 && viewBox.every(Number.isFinite) ? viewBox : [0, 0, width, height];

  const body = root[2]
    .replace(/<\?xml[\s\S]*?\?>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\s+id=(["']).*?\1/g, "");

  return {
    body,
    viewBoxHeight: viewBoxHeight || height || 1,
    viewBoxWidth: viewBoxWidth || width || 1,
    viewBoxX: viewBoxX || 0,
    viewBoxY: viewBoxY || 0,
  };
}

function inlineFormulaSvg(imageTag, formulaSvg) {
  const x = parseSvgLength(getXmlAttribute(imageTag, "x"));
  const y = parseSvgLength(getXmlAttribute(imageTag, "y"));
  const width = parseSvgLength(getXmlAttribute(imageTag, "width"));
  const height = parseSvgLength(getXmlAttribute(imageTag, "height"));
  const scale = Math.min(width / formulaSvg.viewBoxWidth, height / formulaSvg.viewBoxHeight);

  return `<g class="math-svg" transform="translate(${x} ${y}) scale(${scale}) translate(${-formulaSvg.viewBoxX} ${-formulaSvg.viewBoxY})">${formulaSvg.body}</g>`;
}

async function inlineMathSvgImages(svgText, tempDir) {
  const imagePattern = /<image\b[^>]*>/g;
  let output = "";
  let lastIndex = 0;
  let match;

  while ((match = imagePattern.exec(svgText))) {
    const imageTag = match[0];
    const imagePath = getXmlAttribute(imageTag, "href") || getXmlAttribute(imageTag, "xlink:href");
    if (!imagePath.endsWith(".png")) {
      continue;
    }

    const resolved = path.resolve(imagePath);
    if (!isPathInside(resolved, tempDir) && !isPathInside(resolved, MATH_SVG_CACHE_DIR)) {
      continue;
    }

    const formulaSvg = parseFormulaSvg(await readFile(resolved.replace(/\.png$/, ".svg"), "utf8"));
    output += svgText.slice(lastIndex, match.index);
    output += inlineFormulaSvg(imageTag, formulaSvg);
    lastIndex = imagePattern.lastIndex;
  }

  output += svgText.slice(lastIndex);
  return output;
}

async function renderDot2Tex(dotSource, abortSignal) {
  const tempDir = await mkdtemp(path.join(tmpdir(), "graphviz-dot2tex-"));
  const dotPath = path.join(tempDir, "graph.dot");
  const texPath = path.join(tempDir, "graph.tex");
  const svgPath = path.join(tempDir, "graph.svg");

  try {
    await writeFile(dotPath, normalizeDot2TexMath(dotSource), "utf8");
    await runCommand(
      "dot2tex",
      [
        "-ftikz",
        "-traw",
        "--crop",
        "--docpreamble",
        "\\usepackage{amsmath,amssymb}",
        "--output",
        texPath,
        dotPath,
      ],
      { abortSignal, cwd: tempDir },
    );
    await runCommand("pdflatex", ["-interaction=nonstopmode", "-halt-on-error", "graph.tex"], {
      abortSignal,
      cwd: tempDir,
      timeoutMs: 90_000,
    });
    await runCommand("dvisvgm", ["--pdf", "--no-fonts", "--output=graph.svg", "graph.pdf"], {
      abortSignal,
      cwd: tempDir,
      timeoutMs: 90_000,
    });

    return await readFile(svgPath, "utf8");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function renderMathSvg(dotSource, abortSignal) {
  const tempDir = await mkdtemp(path.join(tmpdir(), "graphviz-math-svg-"));
  const dotPath = path.join(tempDir, "graph.dot");

  try {
    const mathDot = await buildMathImageDot(dotSource, abortSignal);
    await writeFile(dotPath, mathDot, "utf8");
    const { stdout } = await runCommand("dot", ["-Tsvg", dotPath], {
      abortSignal,
      cwd: tempDir,
      timeoutMs: 60_000,
    });
    return await inlineMathSvgImages(stdout, tempDir);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function renderDefaultPdf(dotSource, abortSignal) {
  const tempDir = await mkdtemp(path.join(tmpdir(), "graphviz-pdf-"));
  const dotPath = path.join(tempDir, "graph.dot");

  try {
    await writeFile(dotPath, dotSource, "utf8");
    const { stdout } = await runCommand("dot", ["-Tpdf", dotPath], {
      abortSignal,
      cwd: tempDir,
      encoding: "buffer",
      timeoutMs: 60_000,
    });
    return stdout;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function renderDot2TexPdf(dotSource, abortSignal) {
  const tempDir = await mkdtemp(path.join(tmpdir(), "graphviz-dot2tex-pdf-"));
  const dotPath = path.join(tempDir, "graph.dot");
  const texPath = path.join(tempDir, "graph.tex");
  const pdfPath = path.join(tempDir, "graph.pdf");

  try {
    await writeFile(dotPath, normalizeDot2TexMath(dotSource), "utf8");
    await runCommand(
      "dot2tex",
      [
        "-ftikz",
        "-traw",
        "--crop",
        "--docpreamble",
        "\\usepackage{amsmath,amssymb}",
        "--output",
        texPath,
        dotPath,
      ],
      { abortSignal, cwd: tempDir },
    );
    await runCommand("pdflatex", ["-interaction=nonstopmode", "-halt-on-error", "graph.tex"], {
      abortSignal,
      cwd: tempDir,
      timeoutMs: 90_000,
    });
    return await readFile(pdfPath);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function renderMathSvgPdf(dotSource, abortSignal) {
  const tempDir = await mkdtemp(path.join(tmpdir(), "graphviz-math-svg-pdf-"));
  const svgPath = path.join(tempDir, "graph.svg");
  const pdfPath = path.join(tempDir, "graph.pdf");

  try {
    await writeFile(svgPath, await renderMathSvg(dotSource, abortSignal), "utf8");
    await runCommand("inkscape", [svgPath, "--export-type=pdf", `--export-filename=${pdfPath}`], {
      abortSignal,
      cwd: tempDir,
      timeoutMs: 60_000,
    });
    return await readFile(pdfPath);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function renderPdf(dotSource, renderEngine, abortSignal) {
  if (renderEngine === "dot2tex") {
    return await renderDot2TexPdf(dotSource, abortSignal);
  }

  if (renderEngine === "math-svg") {
    return await renderMathSvgPdf(dotSource, abortSignal);
  }

  return await renderDefaultPdf(dotSource, abortSignal);
}

async function runCodex(dotSource, instruction, context, reasoningEffort, renderEngine, abortSignal) {
  const prompt = buildDotUpdatePrompt(dotSource, instruction, normalizeContext(context), {
    renderEngine,
  });
  const tempDir = await mkdtemp(path.join(tmpdir(), "graphviz-codex-"));
  const outputPath = path.join(tempDir, "last-message.json");
  const schemaPath = path.join(__dirname, "codex-output.schema.json");

  try {
    await new Promise((resolve, reject) => {
      let settled = false;
      const child = spawn(
        "codex",
        [
          "exec",
          "--skip-git-repo-check",
          "--ephemeral",
          "--sandbox",
          "read-only",
          "--config",
          `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`,
          "--output-schema",
          schemaPath,
          "--output-last-message",
          outputPath,
          "-",
        ],
        {
          cwd: __dirname,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );

      let stdout = "";
      let stderr = "";

      function finish(error) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        abortSignal?.removeEventListener("abort", abortCodex);
        if (error) {
          reject(error);
          return;
        }
        resolve();
      }

      function abortCodex() {
        child.kill("SIGTERM");
        setTimeout(() => {
          if (!child.killed) child.kill("SIGKILL");
        }, 1500);
        finish(new Error("Codex request was interrupted."));
      }

      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        finish(new Error("Codex timed out."));
      }, CODEX_TIMEOUT_MS);

      if (abortSignal?.aborted) {
        abortCodex();
        return;
      }

      abortSignal?.addEventListener("abort", abortCodex, { once: true });

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (error) => {
        finish(error);
      });
      child.on("close", (code) => {
        if (code === 0) {
          finish();
          return;
        }
        finish(new Error(`Codex exited with ${code}.\n${stderr || stdout}`.trim()));
      });

      child.stdin.end(prompt);
    });

    const lastMessage = await readFile(outputPath, "utf8");
    const parsed = JSON.parse(lastMessage);
    if (
      typeof parsed.hasSuggestion !== "boolean" ||
      typeof parsed.response !== "string" ||
      typeof parsed.output !== "string"
    ) {
      throw new Error("Codex returned an invalid response shape.");
    }

    return {
      hasSuggestion: parsed.hasSuggestion,
      response: parsed.response.trim(),
      output: parsed.output.trim(),
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function serveStatic(request, response) {
  const url = new URL(request.url, `http://${HOST}:${PORT}`);
  const safePath = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  if (!STATIC_FILES.has(safePath)) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  const normalized = path.normalize(safePath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(__dirname, normalized);

  if (!filePath.startsWith(__dirname)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  try {
    const body = await readFile(filePath);
    const type = STATIC_TYPES.get(path.extname(filePath)) || "application/octet-stream";
    response.writeHead(200, {
      "content-type": type,
      "cache-control": "no-store",
    });
    response.end(body);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}

const server = createServer(async (request, response) => {
  if (!isLocalRequest(request)) {
    sendJson(response, 403, { error: "Only local requests are allowed." });
    return;
  }

  if (request.method === "POST" && request.url === "/api/update-dot") {
    const abortController = new AbortController();
    request.on("aborted", () => abortController.abort());
    response.on("close", () => {
      if (!response.writableEnded) abortController.abort();
    });

    try {
      const payload = await readJsonBody(request);
      validateDotRequest(payload);
      const result = await runCodex(
        payload.dotSource,
        payload.instruction,
        payload.context || [],
        payload.reasoningEffort || "medium",
        payload.renderEngine || "default",
        abortController.signal,
      );
      if (response.destroyed) return;
      sendJson(response, 200, result);
    } catch (error) {
      if (response.destroyed) return;
      sendJson(response, 400, { error: error?.message || String(error) });
    }
    return;
  }

  if (request.method === "POST" && request.url === "/api/render-dot2tex") {
    try {
      const abortSignal = getRequestAbortSignal(request, response);
      const payload = await readJsonBody(request);
      validateRenderRequest(payload);
      const svg = await renderWithCache("dot2tex", payload.dotSource, renderDot2Tex, abortSignal);
      if (response.destroyed) return;
      sendJson(response, 200, { svg });
    } catch (error) {
      if (response.destroyed) return;
      sendJson(response, 400, { error: error?.message || String(error) });
    }
    return;
  }

  if (request.method === "POST" && request.url === "/api/render-math-svg") {
    try {
      const abortSignal = getRequestAbortSignal(request, response);
      const payload = await readJsonBody(request);
      validateRenderRequest(payload);
      const svg = await renderWithCache("math-svg", payload.dotSource, renderMathSvg, abortSignal);
      if (response.destroyed) return;
      sendJson(response, 200, { svg });
    } catch (error) {
      if (response.destroyed) return;
      sendJson(response, 400, { error: error?.message || String(error) });
    }
    return;
  }

  if (request.method === "POST" && request.url === "/api/export-pdf") {
    try {
      const abortSignal = getRequestAbortSignal(request, response);
      const payload = await readJsonBody(request);
      validateExportPdfRequest(payload);
      const pdf = await renderPdf(payload.dotSource, payload.renderEngine, abortSignal);
      if (response.destroyed) return;
      sendBinary(response, 200, pdf, "application/pdf", "graphviz-preview.pdf");
    } catch (error) {
      if (response.destroyed) return;
      sendJson(response, 400, { error: error?.message || String(error) });
    }
    return;
  }

  if (request.method === "GET" || request.method === "HEAD") {
    await serveStatic(request, response);
    return;
  }

  response.writeHead(405, { allow: "GET, HEAD, POST" });
  response.end("Method not allowed");
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`Graphviz Codex Visualizer listening on http://${HOST}:${PORT}/\n`);
});
