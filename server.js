import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildDotUpdatePrompt } from "./codexPrompt.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HOST = "127.0.0.1";
const PORT = Number.parseInt(process.env.PORT || "5173", 10);
const MAX_BODY_BYTES = 240_000;
const CODEX_TIMEOUT_MS = 120_000;

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

  const { dotSource, instruction } = payload;
  if (typeof dotSource !== "string" || typeof instruction !== "string") {
    throw new Error("dotSource and instruction must be strings.");
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
}

async function runCodex(dotSource, instruction, abortSignal) {
  const prompt = buildDotUpdatePrompt(dotSource, instruction);
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
    if (typeof parsed.response !== "string" || typeof parsed.output !== "string") {
      throw new Error("Codex returned an invalid response shape.");
    }

    return {
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
      const result = await runCodex(payload.dotSource, payload.instruction, abortController.signal);
      if (response.destroyed) return;
      sendJson(response, 200, result);
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
