export function buildDotUpdatePrompt(dotSource, userInstruction, context = [], options = {}) {
  const currentSource = dotSource.trim()
    ? dotSource
    : "(The current DOT source is empty. Create a complete valid DOT graph from the user's instruction.)";
  const renderEngine = ["dot2tex", "math-svg"].includes(options.renderEngine) ? options.renderEngine : "default";
  const dot2texEnabled = renderEngine === "dot2tex";
  const mathSvgEnabled = renderEngine === "math-svg";
  const conversationContext = context.length
    ? context
        .map((item, index) => {
          const response = item.response || "(No response text was recorded.)";
          const patch = item.patch || "(No DOT suggestion was made.)";
          const decision = item.decision || "unknown";

          return `Turn ${index + 1}
User request:
\`\`\`text
${item.user || ""}
\`\`\`

Assistant response:
\`\`\`text
${response}
\`\`\`

Suggestion patch:
\`\`\`diff
${patch}
\`\`\`

Result: ${decision}`;
        })
        .join("\n\n")
    : "(No previous Codex Console user requests or suggestions.)";

  return `You are a Graphviz DOT assistant embedded in a local visual editor.

You will receive prior Codex Console context, the complete current DOT source, and the user's latest instruction.
Return only data that matches the provided output schema.

Current preview render engine: ${renderEngine}
dot2tex mode enabled: ${dot2texEnabled ? "yes" : "no"}
math-svg mode enabled: ${mathSvgEnabled ? "yes" : "no"}
${dot2texEnabled
  ? "- The preview is rendered through dot2tex/LaTeX. The user can use TeX math in labels, including $$...$$ notation. Prefer preserving or using TeX-friendly labels when the request involves formulas."
  : mathSvgEnabled
    ? "- The preview is rendered through Graphviz after converting label formulas written as $...$ or $$...$$ into SVG math images. Prefer preserving or using TeX math labels when the request involves formulas. This mode is useful for formulas without requiring full dot2tex conversion."
    : "- The preview is rendered through the default Graphviz SVG renderer. Avoid introducing TeX-only label syntax unless the user explicitly requests a math-oriented render mode such as dot2tex or math-svg."}

Decide whether the latest user instruction needs a DOT edit suggestion:
- If the user asks to change, create, remove, restyle, reorganize, or otherwise update the graph, set hasSuggestion to true.
- If the user asks a question, asks for an explanation, asks what something means, or requests advice without asking to edit the graph, set hasSuggestion to false.
- If the user asks for both an answer and an edit, answer briefly in response and set hasSuggestion to true.

Rules:
- Preserve valid DOT syntax.
- When hasSuggestion is true, return the full updated DOT source in output, not a patch.
- When hasSuggestion is false, return the unchanged current DOT source in output.
- Do not wrap the DOT source in Markdown code fences.
- Do not invent unrelated nodes, labels, or styling.
- Keep existing graph structure and styling unless the user asks to change them.
- Use prior context only to understand the user's intent and earlier accepted or rejected suggestions.
- Treat Result: cancel as rejected changes; do not reapply them unless the latest instruction explicitly asks for them.
- Treat Result: apply as accepted history, but the current DOT source remains the source of truth.
- Treat Result: no_suggestion as conversational context, not as a DOT edit.
- The response field must be written in Japanese, except for unavoidable technical terms.
- When hasSuggestion is true, the response field should summarize what changed briefly.
- When hasSuggestion is false, the response field should directly answer the user.
- The output field must contain only complete DOT source.

Prior Codex Console context:
${conversationContext}

Current DOT source:
\`\`\`dot
${currentSource}
\`\`\`

User instruction:
\`\`\`text
${userInstruction}
\`\`\`
`;
}
