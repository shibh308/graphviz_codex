import { instance } from "https://cdn.jsdelivr.net/npm/@viz-js/viz@3.12.0/lib/viz-standalone.mjs";

const initialDot = `digraph G {
  graph [rankdir=LR, bgcolor="transparent"];
  node [shape=box, style="rounded,filled", fillcolor="#f6f8fa", color="#586069", fontname="Arial"];
  edge [color="#586069", fontname="Arial"];

  User -> Editor [label="writes DOT"];
  Editor -> VizJS [label="realtime render"];
  VizJS -> Preview [label="SVG"];
  CodexConsole -> Editor [style=dashed, label="future CLI patch"];
}`;

const editorStatus = document.querySelector("#editorStatus");
const statusSpinner = document.querySelector("#statusSpinner");
const interruptButton = document.querySelector("#interruptButton");
const renderStatus = document.querySelector("#renderStatus");
const renderSpinner = document.querySelector("#renderSpinner");
const preview = document.querySelector("#preview");
const previewStage = document.querySelector("#previewStage");
const resultPanel = document.querySelector("#resultPanel");
const fitButton = document.querySelector("#fitButton");
const downloadButton = document.querySelector("#downloadButton");
const exportFormat = document.querySelector("#exportFormat");
const renderEngine = document.querySelector("#renderEngine");
const promptForm = document.querySelector("#promptForm");
const promptInput = document.querySelector("#promptInput");
const patchChoice = document.querySelector("#patchChoice");
const conversation = document.querySelector("#conversation");
const reasoningEffort = document.querySelector("#reasoningEffort");
const clearLogButton = document.querySelector("#clearLogButton");
const vimModeToggle = document.querySelector("#vimModeToggle");
const vimModeLabel = document.querySelector("#vimModeLabel");
const applyPatchButton = document.querySelector("#applyPatchButton");
const rejectPatchButton = document.querySelector("#rejectPatchButton");
const splitter = document.querySelector("#splitter");
const workspace = document.querySelector(".workspace");

let viz;
let renderTimer = 0;
let renderRequestId = 0;
let renderAbortController = null;
let lastSvgText = "";
let scale = 1;
let panX = 0;
let panY = 0;
let isPreviewDragging = false;
let previewDragLastX = 0;
let previewDragLastY = 0;
let codexBusy = false;
let pendingDot = "";
let reviewBaseDot = "";
let inReviewMode = false;
let codexAbortController = null;
let pendingPatchMessage = null;
let pendingInteraction = null;
let pendingUserMessage = null;
let diffMarkers = [];
const codexHistory = [];
const MAX_HISTORY_ITEMS = 12;

function encodeDotForUrl(dot) {
  return btoa(encodeURIComponent(dot));
}

function decodeDotFromUrl(value) {
  return decodeURIComponent(atob(value));
}

function getInitialDot() {
  const params = new URLSearchParams(window.location.search);
  const encoded = params.get("dot");
  if (!encoded) return initialDot;

  try {
    return decodeDotFromUrl(encoded);
  } catch {
    return initialDot;
  }
}

function getInitialEngine() {
  const engine = new URLSearchParams(window.location.search).get("engine");
  return engine === "dot2tex" || engine === "math-svg" ? engine : "default";
}

function syncStateToUrl(dot = editor.getValue()) {
  const url = new URL(window.location.href);
  url.searchParams.set("dot", encodeDotForUrl(dot));
  url.searchParams.set("engine", renderEngine.value);
  window.history.replaceState(null, "", url);
}

ace.config.set("basePath", "https://cdnjs.cloudflare.com/ajax/libs/ace/1.32.6/");

const editor = ace.edit("editor", {
  mode: "ace/mode/dot",
  theme: "ace/theme/twilight",
  value: getInitialDot(),
  showPrintMargin: false,
  useWorker: false,
  wrap: true,
});

renderEngine.value = getInitialEngine();

editor.session.setUseWrapMode(true);
editor.setOptions({
  fontFamily: "Menlo, Monaco, Consolas, monospace",
  fontSize: "14px",
});

function setRenderStatus(text, state = "") {
  renderStatus.textContent = text;
  renderStatus.style.color = state === "error" ? "#ffb7b7" : state === "ok" ? "#b7efc5" : "";
}

function setRenderBusy(busy) {
  renderSpinner.classList.toggle("hidden", !busy);
}

function setEditorStatus(text) {
  editorStatus.textContent = text;
}

function setCodexStatus(text, busy = false) {
  setEditorStatus(text);
  statusSpinner.classList.toggle("hidden", !busy);
  interruptButton.classList.toggle("hidden", !busy);
}

function appendMessage(kind, text) {
  const message = document.createElement("div");
  message.className = `message ${kind}`;
  const messageText = document.createElement("span");
  messageText.className = "message-text";
  messageText.textContent = text;
  message.append(messageText);
  conversation.append(message);
  conversation.scrollTop = conversation.scrollHeight;
  return message;
}

function markMessageCanceled(message) {
  if (!message) return;

  message.classList.add("canceled");
  if (!message.querySelector(".message-state")) {
    const state = document.createElement("span");
    state.className = "message-state";
    state.textContent = "(canceled)";
    message.append(state);
  }
}

function markMessageInterrupted(message) {
  if (!message) return;

  message.classList.add("interrupted");
}

function markMessageApplied(message) {
  if (!message) return;

  message.classList.add("approved");
}

function resetConversation() {
  codexHistory.length = 0;
  pendingInteraction = null;
  pendingUserMessage = null;
  pendingPatchMessage = null;
  conversation.replaceChildren();
  appendMessage(
    "info",
    "Enter a DOT change request. The local server will ask Codex CLI to rewrite the graph.",
  );
}

function rememberHistory(item) {
  codexHistory.push(item);
  if (codexHistory.length > MAX_HISTORY_ITEMS) {
    codexHistory.splice(0, codexHistory.length - MAX_HISTORY_ITEMS);
  }
}

function showPanel() {
  resultPanel.classList.remove("hidden");
}

function hidePanel() {
  resultPanel.classList.add("hidden");
  resultPanel.replaceChildren();
}

function clearPendingDot() {
  pendingDot = "";
  reviewBaseDot = "";
}

function showErrorPanel(text) {
  resultPanel.className = "preview-panel error-panel";
  resultPanel.replaceChildren();

  const title = document.createElement("div");
  title.className = "panel-title";
  title.textContent = "API Error";

  const body = document.createElement("pre");
  body.className = "error-output";
  body.textContent = text;

  resultPanel.append(title, body);
  showPanel();
}

function buildLineDiff(beforeText, afterText) {
  const before = beforeText.split("\n");
  const after = afterText.split("\n");
  const rows = [];
  let i = 0;
  let j = 0;

  while (i < before.length || j < after.length) {
    if (before[i] === after[j]) {
      rows.push({ type: "same", text: before[i] ?? "" });
      i += 1;
      j += 1;
      continue;
    }

    if (before[i + 1] === after[j]) {
      rows.push({ type: "remove", text: before[i] ?? "" });
      i += 1;
      continue;
    }

    if (before[i] === after[j + 1]) {
      rows.push({ type: "add", text: after[j] ?? "" });
      j += 1;
      continue;
    }

    if (i < before.length) {
      rows.push({ type: "remove", text: before[i] ?? "" });
      i += 1;
    }

    if (j < after.length) {
      rows.push({ type: "add", text: after[j] ?? "" });
      j += 1;
    }
  }

  return rows;
}

function buildPatchText(beforeText, afterText) {
  const rows = buildLineDiff(beforeText, afterText);
  return [
    "--- current.dot",
    "+++ proposed.dot",
    ...rows.map((row) => {
      const prefix = row.type === "add" ? "+" : row.type === "remove" ? "-" : " ";
      return `${prefix}${row.text}`;
    }),
  ].join("\n");
}

function clearDiffMarkers() {
  for (const marker of diffMarkers) {
    editor.session.removeMarker(marker);
  }
  diffMarkers = [];
}

function markDiffRows(rows) {
  clearDiffMarkers();
  const Range = ace.require("ace/range").Range;
  rows.forEach((row, index) => {
    if (row.type !== "add" && row.type !== "remove") return;

    const markerClass = row.type === "add" ? "diff-row-add" : "diff-row-remove";
    const range = new Range(index, 0, index, 1);
    diffMarkers.push(editor.session.addMarker(range, markerClass, "fullLine"));
  });
}

async function enterReviewMode(summary, beforeText, afterText) {
  const diffRows = buildLineDiff(beforeText, afterText);
  const patch = buildPatchText(beforeText, afterText);
  pendingDot = afterText;
  reviewBaseDot = beforeText;
  inReviewMode = true;
  hidePanel();
  patchChoice.classList.remove("hidden");
  promptInput.classList.add("hidden");
  vimModeLabel.classList.add("hidden");
  editor.setReadOnly(true);
  editor.session.setMode("ace/mode/diff");
  editor.setValue(
    diffRows
      .map((row) => {
        const prefix = row.type === "add" ? "+ " : row.type === "remove" ? "- " : "  ";
        return `${prefix}${row.text}`;
      })
      .join("\n"),
    -1,
  );
  markDiffRows(diffRows);
  pendingPatchMessage = appendMessage("suggestion", summary || "DOT更新案を作成しました。");
  if (pendingInteraction) {
    pendingInteraction.response = summary || "";
    pendingInteraction.patch = patch;
    pendingInteraction.decision = "pending";
  }
  await renderDot(afterText, "review pending");
}

function exitReviewMode(nextDot, { canceled = false } = {}) {
  const dot = nextDot ?? reviewBaseDot;
  inReviewMode = false;
  clearDiffMarkers();
  patchChoice.classList.add("hidden");
  promptInput.classList.remove("hidden");
  vimModeLabel.classList.remove("hidden");
  editor.session.setMode("ace/mode/dot");
  editor.setReadOnly(false);
  editor.setValue(dot, -1);
  syncStateToUrl(dot);
  clearPendingDot();
  hidePanel();
  if (canceled) {
    markMessageCanceled(pendingPatchMessage);
  } else {
    markMessageApplied(pendingPatchMessage);
  }
  if (pendingInteraction) {
    pendingInteraction.decision = canceled ? "cancel" : "apply";
    rememberHistory(pendingInteraction);
    pendingInteraction = null;
  }
  pendingPatchMessage = null;
}

function recordNoSuggestion(request, responseText) {
  appendMessage("info", responseText || "変更案はありません。");
  rememberHistory({
    user: request,
    response: responseText || "",
    patch: "",
    decision: "no_suggestion",
  });
  pendingInteraction = null;
}

function applyPendingDot() {
  if (!pendingDot) return;

  exitReviewMode(pendingDot);
}

function rejectPendingDot() {
  exitReviewMode(reviewBaseDot, { canceled: true });
}

function debounceRender() {
  if (inReviewMode) return;
  syncStateToUrl();
  clearTimeout(renderTimer);
  setEditorStatus("editing");
  renderTimer = window.setTimeout(renderGraph, 220);
}

async function renderGraph() {
  await renderDot(editor.getValue());
}

async function renderDot(dot, statusText = null) {
  const requestId = (renderRequestId += 1);
  renderAbortController?.abort();
  renderAbortController = new AbortController();
  setRenderBusy(true);
  setRenderStatus("rendering");

  try {
    if (renderEngine.value === "dot2tex") {
      await renderDot2Tex(dot, requestId, renderAbortController.signal);
    } else if (renderEngine.value === "math-svg") {
      await renderMathSvg(dot, requestId, renderAbortController.signal);
    } else {
      await renderVizJs(dot, requestId);
    }
    if (requestId !== renderRequestId) return;
    scale = 1;
    panX = 0;
    panY = 0;
    applyScale();
    setRenderStatus("rendered", "ok");
    setEditorStatus(statusText || `${dot.length} chars`);
  } catch (error) {
    if (requestId !== renderRequestId) return;
    if (error?.name === "AbortError") return;
    const pre = document.createElement("pre");
    pre.className = "render-error";
    pre.textContent = error?.message || String(error);
    preview.replaceChildren(pre);
    setRenderStatus("render error", "error");
  } finally {
    if (requestId === renderRequestId) {
      renderAbortController = null;
      setRenderBusy(false);
    }
  }
}

async function renderVizJs(dot, requestId) {
  viz ||= await instance();
  const svg = viz.renderSVGElement(dot);
  if (requestId !== renderRequestId) return;
  lastSvgText = new XMLSerializer().serializeToString(svg);
  preview.replaceChildren(svg);
}

async function renderDot2Tex(dot, requestId, abortSignal) {
  const response = await fetch("/api/render-dot2tex", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    signal: abortSignal,
    body: JSON.stringify({ dotSource: dot }),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.error || "dot2tex rendering failed.");
  }
  if (requestId !== renderRequestId) return;

  const parser = new DOMParser();
  const documentSvg = parser.parseFromString(payload.svg, "image/svg+xml");
  const parseError = documentSvg.querySelector("parsererror");
  if (parseError) {
    throw new Error("dot2tex returned invalid SVG.");
  }

  const svg = documentSvg.documentElement;
  lastSvgText = payload.svg;
  preview.replaceChildren(document.importNode(svg, true));
}

async function renderMathSvg(dot, requestId, abortSignal) {
  const response = await fetch("/api/render-math-svg", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    signal: abortSignal,
    body: JSON.stringify({ dotSource: dot }),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.error || "math SVG rendering failed.");
  }
  if (requestId !== renderRequestId) return;

  const parser = new DOMParser();
  const documentSvg = parser.parseFromString(payload.svg, "image/svg+xml");
  const parseError = documentSvg.querySelector("parsererror");
  if (parseError) {
    throw new Error("math SVG renderer returned invalid SVG.");
  }

  const svg = documentSvg.documentElement;
  lastSvgText = payload.svg;
  preview.replaceChildren(document.importNode(svg, true));
}

function applyScale() {
  const svg = preview.querySelector("svg");
  if (!svg) return;
  if (!svg.dataset.naturalWidth || !svg.dataset.naturalHeight) {
    const viewBox = svg.viewBox?.baseVal;
    const box = svg.getBoundingClientRect();
    svg.dataset.naturalWidth = String(svg.width?.baseVal?.value || viewBox?.width || box.width || 1);
    svg.dataset.naturalHeight = String(svg.height?.baseVal?.value || viewBox?.height || box.height || 1);
  }

  const width = Number.parseFloat(svg.dataset.naturalWidth);
  const height = Number.parseFloat(svg.dataset.naturalHeight);
  const scaledWidth = width * scale;
  const scaledHeight = height * scale;
  const stageBox = previewStage.getBoundingClientRect();
  svg.style.width = `${scaledWidth}px`;
  svg.style.height = `${scaledHeight}px`;
  svg.style.transform = `translate(${panX}px, ${panY}px)`;
  preview.style.width = `${Math.max(stageBox.width, scaledWidth + 56)}px`;
  preview.style.height = `${Math.max(stageBox.height, scaledHeight + 56)}px`;
}

function zoomPreview(event) {
  const svg = preview.querySelector("svg");
  if (!svg || event.ctrlKey) return;

  event.preventDefault();
  const previousScale = scale;
  const zoomFactor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
  const nextScale = Math.max(0.1, Math.min(5, previousScale * zoomFactor));
  if (nextScale === previousScale) return;

  const stageBox = previewStage.getBoundingClientRect();
  const anchorX = event.clientX - stageBox.left + previewStage.scrollLeft;
  const anchorY = event.clientY - stageBox.top + previewStage.scrollTop;
  scale = nextScale;
  applyScale();
  previewStage.scrollLeft = anchorX * (nextScale / previousScale) - (event.clientX - stageBox.left);
  previewStage.scrollTop = anchorY * (nextScale / previousScale) - (event.clientY - stageBox.top);
}

function startPreviewDrag(event) {
  if (event.button !== 0 || event.target.closest(".preview-panel")) return;

  event.preventDefault();
  isPreviewDragging = true;
  previewDragLastX = event.clientX;
  previewDragLastY = event.clientY;
  previewStage.classList.add("dragging");
  window.addEventListener("pointermove", dragPreview);
  window.addEventListener("pointerup", stopPreviewDrag, { once: true });
  window.addEventListener("pointercancel", stopPreviewDrag, { once: true });
}

function dragPreview(event) {
  if (!isPreviewDragging) return;

  event.preventDefault();
  panX += event.clientX - previewDragLastX;
  panY += event.clientY - previewDragLastY;
  previewDragLastX = event.clientX;
  previewDragLastY = event.clientY;
  applyScale();
}

function stopPreviewDrag() {
  if (!isPreviewDragging) return;

  isPreviewDragging = false;
  previewStage.classList.remove("dragging");
  window.removeEventListener("pointermove", dragPreview);
  window.removeEventListener("pointerup", stopPreviewDrag);
  window.removeEventListener("pointercancel", stopPreviewDrag);
}

function fitGraph() {
  const svg = preview.querySelector("svg");
  if (!svg) return;
  applyScale();

  const stageBox = previewStage.getBoundingClientRect();
  const width = Number.parseFloat(svg.dataset.naturalWidth);
  const height = Number.parseFloat(svg.dataset.naturalHeight);
  if (!width || !height) return;

  const xScale = (stageBox.width - 56) / width;
  const yScale = (stageBox.height - 56) / height;
  scale = Math.max(0.25, Math.min(1.75, xScale, yScale));
  panX = 0;
  panY = 0;
  applyScale();
  previewStage.scrollLeft = Math.max(0, (preview.scrollWidth - stageBox.width) / 2);
  previewStage.scrollTop = Math.max(0, (preview.scrollHeight - stageBox.height) / 2);
}

function downloadSvg() {
  if (!lastSvgText) return;

  const blob = new Blob([lastSvgText], { type: "image/svg+xml" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "graphviz-preview.svg";
  anchor.click();
  URL.revokeObjectURL(url);
}

function downloadPng() {
  if (!lastSvgText) return;

  const svg = preview.querySelector("svg");
  const viewBox = svg?.viewBox?.baseVal;
  const width = Math.ceil(viewBox?.width || svg?.width?.baseVal?.value || 1200);
  const height = Math.ceil(viewBox?.height || svg?.height?.baseVal?.value || 800);
  const canvas = document.createElement("canvas");
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = width * pixelRatio;
  canvas.height = height * pixelRatio;

  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.scale(pixelRatio, pixelRatio);

  const image = new Image();
  const blob = new Blob([lastSvgText], { type: "image/svg+xml" });
  const url = URL.createObjectURL(blob);

  image.onload = () => {
    context.drawImage(image, 0, 0, width, height);
    URL.revokeObjectURL(url);
    const anchor = document.createElement("a");
    anchor.href = canvas.toDataURL("image/png");
    anchor.download = "graphviz-preview.png";
    anchor.click();
  };

  image.onerror = () => {
    URL.revokeObjectURL(url);
    setRenderStatus("png failed", "error");
  };

  image.src = url;
}

async function downloadPdf() {
  setRenderBusy(true);
  setRenderStatus("exporting");

  try {
    const response = await fetch("/api/export-pdf", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        dotSource: editor.getValue(),
        renderEngine: renderEngine.value,
      }),
    });

    if (!response.ok) {
      let message = "pdf export failed.";
      try {
        const payload = await response.json();
        message = payload?.error || message;
      } catch {
        message = await response.text();
      }
      throw new Error(message);
    }

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "graphviz-preview.pdf";
    anchor.click();
    URL.revokeObjectURL(url);
    setRenderStatus("rendered", "ok");
  } catch (error) {
    setRenderStatus("pdf failed", "error");
    const pre = document.createElement("pre");
    pre.className = "render-error";
    pre.textContent = error?.message || String(error);
    preview.replaceChildren(pre);
  } finally {
    setRenderBusy(false);
  }
}

function downloadGraph() {
  if (exportFormat.value === "pdf") {
    downloadPdf();
    return;
  }

  if (exportFormat.value === "png") {
    downloadPng();
    return;
  }

  downloadSvg();
}

async function applyCodexPrompt(event) {
  event?.preventDefault();
  if (codexBusy || inReviewMode) return;

  const request = promptInput.value.trim();
  if (!request) return;

  pendingUserMessage = appendMessage("user", request);
  pendingInteraction = {
    user: request,
    response: "",
    patch: "",
    decision: "pending",
  };
  promptInput.value = "";
  promptInput.disabled = true;
  reasoningEffort.disabled = true;
  codexBusy = true;
  clearPendingDot();
  hidePanel();
  setCodexStatus("codex running", true);
  const currentDot = editor.getValue();
  codexAbortController = new AbortController();

  try {
    const response = await fetch("/api/update-dot", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      signal: codexAbortController.signal,
      body: JSON.stringify({
        dotSource: currentDot,
        instruction: request,
        reasoningEffort: reasoningEffort.value,
        renderEngine: renderEngine.value,
        context: codexHistory,
      }),
    });

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload?.error || "Codex request failed.");
    }

    if (payload.hasSuggestion && payload.output !== currentDot) {
      setCodexStatus("review pending");
      await enterReviewMode(payload.response, currentDot, payload.output);
      pendingUserMessage = null;
    } else {
      setCodexStatus("ready");
      recordNoSuggestion(request, payload.response);
      pendingUserMessage = null;
    }
  } catch (error) {
    if (error?.name === "AbortError") {
      markMessageInterrupted(pendingUserMessage);
      appendMessage("warning", "Codex request interrupted.");
      if (pendingInteraction) {
        pendingInteraction.response = "Codex request interrupted.";
        pendingInteraction.decision = "interrupted";
        rememberHistory(pendingInteraction);
      }
      setCodexStatus("interrupted");
      pendingInteraction = null;
      pendingUserMessage = null;
      return;
    }

    const message = error?.message || String(error);
    appendMessage("warning", `Codex error: ${message}`);
    if (pendingInteraction) {
      pendingInteraction.response = message;
      pendingInteraction.decision = "error";
      rememberHistory(pendingInteraction);
    }
    showErrorPanel(message);
    setCodexStatus("codex error");
    pendingInteraction = null;
    pendingUserMessage = null;
  } finally {
    codexBusy = false;
    codexAbortController = null;
    statusSpinner.classList.add("hidden");
    interruptButton.classList.add("hidden");
    promptInput.disabled = false;
    reasoningEffort.disabled = false;
    if (!inReviewMode) {
      promptInput.focus();
    }
  }
}

function interruptCodex() {
  if (!codexBusy || !codexAbortController) return;
  codexAbortController.abort();
}

function handlePromptKeydown(event) {
  if (event.key !== "Enter" || event.shiftKey) return;

  event.preventDefault();
  applyCodexPrompt();
}

function toggleVimMode() {
  editor.setKeyboardHandler(vimModeToggle.checked ? "ace/keyboard/vim" : null);
  editor.focus();
}

function startResize(event) {
  event.preventDefault();
  document.body.classList.add("resizing");
  window.addEventListener("pointermove", resizePanes);
  window.addEventListener("pointerup", stopResize, { once: true });
}

function resizePanes(event) {
  const bounds = workspace.getBoundingClientRect();
  const minLeft = 300;
  const minRight = 360;
  const maxLeft = bounds.width - minRight - splitter.offsetWidth;
  const nextWidth = Math.min(maxLeft, Math.max(minLeft, event.clientX - bounds.left));
  workspace.style.setProperty("--source-width", `${nextWidth}px`);
  editor.resize();
}

function stopResize() {
  document.body.classList.remove("resizing");
  window.removeEventListener("pointermove", resizePanes);
}

editor.session.on("change", debounceRender);
fitButton.addEventListener("click", fitGraph);
downloadButton.addEventListener("click", downloadGraph);
renderEngine.addEventListener("change", () => {
  syncStateToUrl();
  renderGraph();
});
previewStage.addEventListener("wheel", zoomPreview, { passive: false });
previewStage.addEventListener("pointerdown", startPreviewDrag);
promptForm.addEventListener("submit", applyCodexPrompt);
promptInput.addEventListener("keydown", handlePromptKeydown);
vimModeToggle.addEventListener("change", toggleVimMode);
splitter.addEventListener("pointerdown", startResize);
applyPatchButton.addEventListener("click", applyPendingDot);
rejectPatchButton.addEventListener("click", rejectPendingDot);
interruptButton.addEventListener("click", interruptCodex);
clearLogButton.addEventListener("click", resetConversation);

syncStateToUrl();
renderGraph();
