/**
 * Conciseness rules — keep model output tight so we don't waste output tokens
 * or balloon the chat history. Cacheable.
 */

export function getOutputEfficiencySection(): string {
  return `═══ OUTPUT EFFICIENCY ═══

- Be concise in "content" and "reasoning". One sentence is usually enough.
- Don't restate what the user said back to them.
- Don't narrate the next step ("now I will...") — just emit the tool call.
- Don't include filler ("Sure!", "Of course!", "I'll be happy to...").
- For "completed", lead with what was built; the summary box is the highlight, not a recap of every tool call.
- Reasoning is for YOU and the user's debugging — not for explaining the tool you're about to call.`
}
