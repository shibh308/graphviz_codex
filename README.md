# Graphviz Codex Visualizer

Local-only Graphviz DOT editor with live preview and Codex CLI assisted DOT updates.

This tool is intended for personal use on a trusted local machine. It assumes `codex` is already installed and usable from the server process environment. It is not designed to be exposed to the internet or shared on a public network.

## Requirements

- Node.js
- Codex CLI available as `codex`
- A browser with network access to the frontend CDN dependencies:
  - Ace editor
  - `@viz-js/viz`

## Run

```bash
npm start
```

or:

```bash
node server.js
```

Then open:

```text
http://127.0.0.1:5173/
```
