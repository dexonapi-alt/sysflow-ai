/**
 * Plan `2026-05-15-forced-error-reasoning-and-recovery.md` Stage 3.
 *
 * Pure renderer for the mandatory `═══ ERROR — REASON THROUGH THIS ═══`
 * block. Called from `base-provider.ts: buildToolResultMessage` when
 * the run has an active error-reasoning brief (set by tool-result.ts
 * after running `runErrorReasoningChain`).
 *
 * The block is the system-level enforcement against the failure mode
 * the user reported — *"when it receives error the llm is so
 * inconsistent it just proceed to the next thing he do without
 * realizing he made an error"*. By INJECTING this block at the very
 * end of the tool-result message body (last thing before the model's
 * response window), the agent is forced to address the error in its
 * `reasoningChain` before proceeding.
 *
 * Same pattern as Stage 1 of free-tier-quality-enforcement (verify-
 * after-write) + Stage 3 (mandatory self-review).
 */

export interface ErrorReasoningBlockArgs {
  /** Verbatim error / stderr the failed tool returned. */
  errorText: string
  /** Tool that failed (`run_command`, `write_file`, etc.). */
  tool: string
  /** Brief from `runErrorReasoningChain`. Carries root cause +
   *  platform context + alternative commands + the recommended one. */
  brief: {
    rootCause: string
    platformContext: string
    alternativeCommands: string[]
    recommendedCommand: string
    confidence: "HIGH" | "MEDIUM" | "LOW"
  }
}

/**
 * Render the error-reasoning directive block. Pure — no I/O.
 *
 * The block sits at the END of the tool-result message body so it's
 * the last thing the model reads before responding. Order vs the
 * other inject blocks (verify-after-write / mandatory-self-review /
 * chunk-plan) is intentional: the error block fires when an error
 * actually occurred — the OTHER blocks fire on chunk boundaries that
 * may or may not include errors. When both an error AND a chunk
 * boundary fire on the same turn, the error block wins the LAST
 * position because it's the more time-sensitive concern.
 */
export function buildErrorReasoningBlock(args: ErrorReasoningBlockArgs): string {
  const { errorText, tool, brief } = args

  // Confidence-aware framing. HIGH-confidence picks render as
  // `RECOMMENDED:`; MEDIUM/LOW as `SUGGESTED:` so the agent doesn't
  // trust them as gospel when the reasoner itself wasn't certain.
  const recommendationLabel = brief.confidence === "HIGH" ? "RECOMMENDED" : "SUGGESTED"

  // Truncate the error text shown in the block — the full text is
  // already in the model's preceding context (the tool result).
  // Showing the full thing again would just bloat the prompt.
  const truncatedError = errorText.length > 600
    ? errorText.slice(0, 600).trimEnd() + " …(truncated)"
    : errorText

  const alternativesLine = brief.alternativeCommands.length > 0
    ? `ALTERNATIVES: ${brief.alternativeCommands.slice(0, 5).join(" · ")}`
    : "ALTERNATIVES: (none — reasoner did not surface any)"

  return `

═══ ERROR — REASON THROUGH THIS ═══

The previous \`${tool}\` call FAILED. Before doing ANYTHING else:

1. In your \`reasoningChain[]\` for THIS response, ACKNOWLEDGE the
   failure explicitly. Quote the exact error text. Don't pretend it
   didn't happen.

2. Reason about WHY it failed. The reasoner already analysed this —
   the root-cause hypothesis + platform context are below. Engage
   with them; either confirm or surface a different theory.

3. Pick ONE of the alternatives the reasoner suggested (or your
   own if you genuinely think it's better). Explain WHY this one
   will work where the failed one didn't.

4. Then issue the corrected tool call.

ERROR (excerpt): ${truncatedError}
ROOT CAUSE (reasoner): ${brief.rootCause}
PLATFORM: ${brief.platformContext}
${recommendationLabel}: ${brief.recommendedCommand}
${alternativesLine}

Do NOT proceed past this error without addressing it. Do NOT
switch topics (web search, unrelated file reads, "let me think
about something else") — that's the failure mode this block exists
to prevent.

═══ END ERROR ═══`
}

/**
 * True when a tool result carries an actual error (not a benign
 * skip / warning / informational message). Same gate the existing
 * `tool-error-classifier` uses; centralised here so the inject block
 * and the chain-trigger logic both agree on what counts.
 */
export function isToolResultError(result: Record<string, unknown> | undefined): boolean {
  if (!result) return false
  if (typeof result.error === "string" && result.error.length > 0) return true
  if (result.success === false) return true
  // `skipped: true` is NOT an error — it's an explicit "we didn't
  // run this; the user will". Same for `timedOut` (already handled
  // by its own surfacing).
  return false
}
