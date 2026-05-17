/**
 * Stage 5 of `2026-05-16-accountability-and-parallel-execution-sequencing.md`.
 *
 * Server-side gate that rejects model responses whose `tools[]`
 * batch size exceeds a threshold AND whose `reasoningChain[]` has
 * fewer non-empty paragraphs than the batch size. Mirrors the
 * forced-error-reasoning Stage 4 rejection-loop pattern: validate
 * after `callModelAdapter` resolves, inject a reject prompt via
 * `actionPlanner.injectContext`, re-call the adapter. Bounded at
 * `MAX_PER_FILE_REASONING_REJECTIONS` (3) per run so a stuck model
 * can't hold the handler forever.
 *
 * The gate enforces the user-reported requirement: *"it needs to
 * reason every file he make and edit"*. Stage 1's cli-side cap
 * (default 3 tools) keeps batches small enough that per-file
 * reasoning is feasible; Stage 5 ensures that when the batch DOES
 * exceed the threshold, the reasoning grows with it.
 *
 * Pure module — no I/O. The rejection counter lives in
 * `tool-result.ts` / `user-message.ts` alongside the existing
 * `errorAcknowledgementRejections` counter; this module just
 * provides the predicate + prompt builder.
 */

export interface PerFileReasoningInput {
  /** The normalised response's discriminator. */
  responseKind: string
  /** `normalized.tools` from the model adapter (untyped — only length matters). */
  tools: unknown
  /** `normalized.reasoningChain` from the model adapter. */
  reasoningChain: unknown
  /**
   * Batch size threshold above which the gate enforces per-file
   * reasoning. From `quality.per_file_reasoning_threshold` flag
   * (default 3). Responses with `tools.length <= threshold` skip
   * the check entirely.
   */
  threshold: number
}

export interface PerFileReasoningResult {
  /** True when the response is acceptable. */
  ok: boolean
  /** Short reason — surfaces in the inject + logs. */
  reason?: string
  /** Observed counts so the prompt builder can echo them back. */
  toolCount?: number
  reasoningCount?: number
}

/**
 * Pure predicate. The gate fires only when ALL of:
 *   - response kind is `needs_tool` (tool batches don't exist on
 *     `completed` / `waiting_for_user` etc.),
 *   - `tools.length > threshold`,
 *   - non-empty paragraphs in `reasoningChain` < `tools.length`.
 *
 * Empty / whitespace-only reasoning paragraphs don't count toward
 * the per-file budget — they're filler not justification.
 */
export function validatePerFileReasoning(input: PerFileReasoningInput): PerFileReasoningResult {
  if (input.responseKind !== "needs_tool") return { ok: true }
  const tools = Array.isArray(input.tools) ? input.tools : []
  if (tools.length <= input.threshold) return { ok: true }
  const reasoningRaw = Array.isArray(input.reasoningChain) ? input.reasoningChain : []
  const reasoningCount = reasoningRaw.filter(
    (p) => typeof p === "string" && p.trim().length > 0,
  ).length
  if (reasoningCount >= tools.length) return { ok: true }
  return {
    ok: false,
    reason: `${tools.length} tool calls in batch but only ${reasoningCount} reasoning paragraph${reasoningCount === 1 ? "" : "s"}`,
    toolCount: tools.length,
    reasoningCount,
  }
}

/**
 * Build the reject-prompt block. Surfaced via `actionPlanner.injectContext`
 * so the next `callModelAdapter` invocation sees it as injected guidance.
 *
 * The block names BOTH escape hatches (reduce batch, OR add paragraphs)
 * so the agent has explicit agency — the gate doesn't pre-decide
 * which path to take.
 */
export function buildInsufficientReasoningPrompt(
  check: PerFileReasoningResult,
  threshold: number,
  rejection: number,
  maxRejections: number,
): string {
  const toolCount = check.toolCount ?? 0
  const reasoningCount = check.reasoningCount ?? 0
  return [
    "═══ INSUFFICIENT REASONING FOR BATCH ═══",
    "",
    `You emitted ${toolCount} tool calls in one batch but only ${reasoningCount} paragraph${reasoningCount === 1 ? "" : "s"} in reasoningChain[].`,
    "",
    "Required: one paragraph in reasoningChain per file/tool justifying why THIS file matters and how it fits the build plan. Without this, your peers (and the user watching the reasoning peek) can't follow your decisions.",
    "",
    "Either:",
    ` 1. Reduce the batch size to ≤ ${threshold} tool${threshold === 1 ? "" : "s"}, OR`,
    " 2. Add reasoning paragraphs (one per tool) and resubmit.",
    "",
    `(rejection ${rejection}/${maxRejections} — the response will be retried)`,
    "═══ END INSUFFICIENT REASONING ═══",
  ].join("\n")
}

/** Per-run rejection counter cap. Matches the forced-error-reasoning Stage 4 cap. */
export const MAX_PER_FILE_REASONING_REJECTIONS = 3
