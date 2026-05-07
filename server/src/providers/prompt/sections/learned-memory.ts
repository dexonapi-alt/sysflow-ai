/**
 * Learned project memory section. Renders ACTIVE + VALID memory entries
 * the recall step picked. Non-cacheable — depends on per-request cwd
 * + memory file mtime + the recall result.
 *
 * Always sits AFTER project-memory (priority 105) so the user's
 * hand-written .sysflow.md takes precedence in the agent's reading
 * order, and BEFORE reasoning_brief (priority 107) so the brief sits
 * on top of both.
 */

export interface LearnedMemoryCtx {
  /** Pre-rendered entries from recallForReasoning. Each is one line. */
  learnedMemoryLines?: string[]
  /** For the header — how many were considered total + how many filtered out. */
  learnedMemorySummary?: { totalConsidered: number; staleCount: number; contradictedCount: number }
}

const MAX_RENDER_CHARS_PER_LINE = 200

export function getLearnedMemorySection(ctx: LearnedMemoryCtx): string | null {
  const lines = ctx.learnedMemoryLines ?? []
  if (lines.length === 0) return null

  const summary = ctx.learnedMemorySummary
  const headerSuffix = summary
    ? ` (${lines.length} of ${summary.totalConsidered}; ${summary.staleCount} stale, ${summary.contradictedCount} contradicted)`
    : ""

  const out: string[] = []
  out.push(`═══ LEARNED PROJECT MEMORY${headerSuffix} ═══`)
  out.push("")
  out.push("Auto-recorded facts from previous runs in THIS project, validated against current files + deps.")
  out.push("Trust them unless your tool results contradict — they're not user-written, they're the agent's prior work.")
  out.push("For human-written conventions see PROJECT MEMORY above.")
  out.push("")
  for (const raw of lines) {
    const trimmed = raw.length > MAX_RENDER_CHARS_PER_LINE
      ? raw.slice(0, MAX_RENDER_CHARS_PER_LINE) + "…"
      : raw
    out.push(`- ${trimmed}`)
  }
  out.push("")
  // Phase 15 Stage 4: active-confirmation contract.
  // The handler runs every response through applyMemoryFeedback with
  // cross-validation guards: a `confirmed` claim is rejected unless ≥30%
  // of the entry's tokens appear in the response; a `contradicted` claim
  // is rejected unless the response references the entry's [id] in
  // brackets. Hallucinated feedback is silently dropped.
  out.push("Memory feedback contract — when you respond, include a top-level `memoryFeedback` field:")
  out.push("  \"memoryFeedback\": {")
  out.push("    \"confirmed\":   [\"<id>\", \"<id>\"],   // entry ids you used or built on this turn")
  out.push("    \"contradicted\": [\"<id>\"]            // entry ids the conversation disagreed with")
  out.push("  }")
  out.push("To contradict an entry you MUST reference its [id] in the response text — show the user what you disagreed with.")
  out.push("Omit the field (or use empty arrays) when no entries were used or contradicted this turn.")
  return out.join("\n")
}

/**
 * Render a single MemoryEntry into one bullet line for the prompt.
 * Format: "[<id>] <kind>: <one-line content>"
 */
export function renderEntryLine(e: { id: string; kind: string; content: string }): string {
  const oneLine = e.content.replace(/\s+/g, " ").trim()
  return `[${e.id}] ${e.kind}: ${oneLine}`
}
