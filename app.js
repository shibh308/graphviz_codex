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
const preview = document.querySelector("#preview");
const previewStage = document.querySelector("#previewStage");
const resultPanel = document.querySelector("#resultPanel");
const fitButton = document.querySelector("#fitButton");
const downloadButton = document.querySelector("#downloadButton");
const exportFormat = document.querySelector("#exportFormat");
const promptForm = document.querySelector("#promptForm");
const promptInput = document.querySelector("#promptInput");
const conversation = document.querySelector("#conversation");
const vimModeToggle = document.querySelector("#vimModeToggle");
const vimModeLabel = document.querySelector("#vimModeLabel");
const reviewActions = document.querySelector("#reviewActions");
const applyPatchButton = document.querySelector("#applyPatchButton");
const rejectPatchButton = document.querySelector("#rejectPatchButton");
const splitter = document.querySelector("#splitter");
const workspace = document.querySelector(".workspace");

let viz;
let renderTimer = 0;
let lastSvgText = "";
let scale = 1;
let codexBusy = false;
let pendingDot = "";
let reviewBaseDot = "";
let inReviewMode = false;
let codexAbortController = null;
let pendingPatchMessage = null;

function encodeDotForUrl(dot) {
  return btoa(encodeURIComponent(dot));
}

function decodeDotFromUrl(value) {
  return decodeURIComponent(atob(value));
}

function getInitialDot() {
  const encoded = new URLSearchParams(window.location.search).get("dot");
  if (!encoded) return initialDot;

  try {
    return decodeDotFromUrl(encoded);
  } catch {
    return initialDot;
  }
}

function syncDotToUrl(dot) {
  const url = new URL(window.location.href);
  url.searchParams.set("dot", encodeDotForUrl(dot));
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

editor.session.setUseWrapMode(true);
editor.setOptions({
  fontFamily: "Menlo, Monaco, Consolas, monospace",
  fontSize: "14px",
});

function setRenderStatus(text, state = "") {
  renderStatus.textContent = text;
  renderStatus.style.color = state === "error" ? "#ffb7b7" : state === "ok" ? "#b7efc5" : "";
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

function buildDiffText(beforeText, afterText) {
  return buildLineDiff(beforeText, afterText)
    .map((row) => {
      const prefix = row.type === "add" ? "+ " : row.type === "remove" ? "- " : "  ";
      return `${prefix}${row.text}`;
    })
    .join("\n");
}

async function enterReviewMode(summary, beforeText, afterText) {
  pendingDot = afterText;
  reviewBaseDot = beforeText;
  inReviewMode = true;
  hidePanel();
  reviewActions.classList.remove("hidden");
  vimModeLabel.classList.add("hidden");
  editor.setReadOnly(true);
  editor.session.setMode("ace/mode/diff");
  editor.setValue(buildDiffText(beforeText, afterText), -1);
  pendingPatchMessage = appendMessage("assistant", summary || "DOT更新案を作成しました。");
  await renderDot(afterText, "review pending");
}

function exitReviewMode(nextDot, { canceled = false } = {}) {
  const dot = nextDot ?? reviewBaseDot;
  inReviewMode = false;
  reviewActions.classList.add("hidden");
  vimModeLabel.classList.remove("hidden");
  editor.session.setMode("ace/mode/dot");
  editor.setReadOnly(false);
  editor.setValue(dot, -1);
  syncDotToUrl(dot);
  clearPendingDot();
  hidePanel();
  if (canceled) {
    markMessageCanceled(pendingPatchMessage);
  }
  pendingPatchMessage = null;
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
  syncDotToUrl(editor.getValue());
  clearTimeout(renderTimer);
  setEditorStatus("editing");
  renderTimer = window.setTimeout(renderGraph, 220);
}

async function renderGraph() {
  await renderDot(editor.getValue());
}

async function renderDot(dot, statusText = null) {
  setRenderStatus("rendering");

  try {
    viz ||= await instance();
    const svg = viz.renderSVGElement(dot);
    lastSvgText = new XMLSerializer().serializeToString(svg);
    preview.replaceChildren(svg);
    scale = 1;
    applyScale();
    setRenderStatus("rendered", "ok");
    setEditorStatus(statusText || `${dot.length} chars`);
  } catch (error) {
    const pre = document.createElement("pre");
    pre.className = "render-error";
    pre.textContent = error?.message || String(error);
    preview.replaceChildren(pre);
    setRenderStatus("syntax error", "error");
  }
}

function applyScale() {
  const svg = preview.querySelector("svg");
  if (!svg) return;
  svg.style.transform = `scale(${scale})`;
}

function fitGraph() {
  const svg = preview.querySelector("svg");
  if (!svg) return;

  const stageBox = previewStage.getBoundingClientRect();
  const graphBox = svg.getBoundingClientRect();
  if (!graphBox.width || !graphBox.height) return;

  const xScale = (stageBox.width - 56) / graphBox.width;
  const yScale = (stageBox.height - 56) / graphBox.height;
  scale = Math.max(0.25, Math.min(1.75, xScale, yScale));
  applyScale();
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

function downloadGraph() {
  if (exportFormat.value === "png") {
    downloadPng();
    return;
  }

  downloadSvg();
}

async function applyCodexPrompt(event) {
  event?.preventDefault();
  if (codexBusy) return;

  const request = promptInput.value.trim();
  if (!request) return;

  appendMessage("user", request);
  promptInput.value = "";
  promptInput.disabled = true;
  codexBusy = true;
  clearPendingDot();
  if (inReviewMode) exitReviewMode(reviewBaseDot, { canceled: true });
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
      }),
    });

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload?.error || "Codex request failed.");
    }

    setCodexStatus("review pending");
    await enterReviewMode(payload.response, currentDot, payload.output);
  } catch (error) {
    if (error?.name === "AbortError") {
      appendMessage("error", "Codex request interrupted.");
      setCodexStatus("interrupted");
      return;
    }

    const message = error?.message || String(error);
    appendMessage("error", `Codex error: ${message}`);
    showErrorPanel(message);
    setCodexStatus("codex error");
  } finally {
    codexBusy = false;
    codexAbortController = null;
    statusSpinner.classList.add("hidden");
    interruptButton.classList.add("hidden");
    promptInput.disabled = false;
    promptInput.focus();
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
promptForm.addEventListener("submit", applyCodexPrompt);
promptInput.addEventListener("keydown", handlePromptKeydown);
vimModeToggle.addEventListener("change", toggleVimMode);
splitter.addEventListener("pointerdown", startResize);
applyPatchButton.addEventListener("click", applyPendingDot);
rejectPatchButton.addEventListener("click", rejectPendingDot);
interruptButton.addEventListener("click", interruptCodex);

syncDotToUrl(editor.getValue());
renderGraph();
