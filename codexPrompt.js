export function buildDotUpdatePrompt(dotSource, userInstruction) {
  const currentSource = dotSource.trim()
    ? dotSource
    : "(The current DOT source is empty. Create a complete valid DOT graph from the user's instruction.)";

  return `You update Graphviz DOT source exactly according to the user's request.

You will receive the complete current DOT source and the user's instruction.
Return only data that matches the provided output schema.

Rules:
- Preserve valid DOT syntax.
- Return the full updated DOT source, not a patch.
- Do not wrap the DOT source in Markdown code fences.
- Do not invent unrelated nodes, labels, or styling.
- Keep existing graph structure and styling unless the user asks to change them.
- The response field must be written in Japanese, except for unavoidable technical terms.
- The response field should summarize what changed briefly.
- The output field must contain only the complete updated DOT source.

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
