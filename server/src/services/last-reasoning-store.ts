/**
 * Stage 5 of free-tier-quality-enforcement plan: per-run cache of the
 * main model's most recent `reasoningChain[]`.
 *
 * The reasoner-vs-action cross-check needs to compare what the model
 * SAID it was going to do (last paragraph of the chain) against what
 * it actually emitted as a tool call (next turn's tool-result). Those
 * two events live in different handlers, so we stash the reasoning in
 * a tiny in-memory map keyed by runId.
 *
 * Cleared by `clearLastReasoning(runId)` from the terminal-cleanup path
 * in `tool-result.ts`, paired with `clearChunkState` / `clearLedger` /
 * `clearReviewState` / `clearConfidence`.
 *
 * Stays in-process (no DB) on purpose — the comparison only matters
 * across consecutive turns of the SAME run; nothing else cares about
 * the value.
 */

const lastReasoningByRun = new Map<string, string[]>()

/** Replace the cached chain for a run. Empty / non-array input clears
 *  the entry (no chain → nothing to compare against next turn). */
export function setLastReasoning(runId: string, chain: string[] | null | undefined): void {
  if (!runId) return
  if (!Array.isArray(chain) || chain.length === 0) {
    lastReasoningByRun.delete(runId)
    return
  }
  // Defensive filter — the normaliser should have done this already,
  // but never trust upstream.
  const filtered = chain.filter((p): p is string => typeof p === "string" && p.trim().length > 0)
  if (filtered.length === 0) {
    lastReasoningByRun.delete(runId)
    return
  }
  lastReasoningByRun.set(runId, filtered)
}

/** Read the cached chain, or `null` if nothing has been stashed yet. */
export function getLastReasoning(runId: string): string[] | null {
  return lastReasoningByRun.get(runId) ?? null
}

/** Drop the cached chain. Called from the same teardown path as the
 *  other per-run state stores. */
export function clearLastReasoning(runId: string): void {
  lastReasoningByRun.delete(runId)
}

/** Test-only helper. */
export function _resetLastReasoningForTests(): void {
  lastReasoningByRun.clear()
}
