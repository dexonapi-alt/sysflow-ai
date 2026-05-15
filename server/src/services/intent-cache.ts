/**
 * Plan `2026-05-15-llm-iterative-intent-classification.md` Stage 3.
 *
 * Per-run cache for the classified `IntentHint`. The LLM iterative
 * chain (`classifyIntentByChain`) is the most expensive layer of the
 * classifier — running it on every tool-result response would burn
 * Flash calls for a value that's constant for the duration of the run
 * (the user prompt doesn't change mid-run). The cache makes
 * classification fire ONCE per run on the first turn; every
 * subsequent call (`tool-result.ts` setting `clientResp.runIntent`,
 * `pickPipeline` selecting the preflight pipeline) reads the cached
 * value.
 *
 * Same pattern as the other per-run state stores
 * (`runTaskPlanGate` on BaseProvider, `last-reasoning-store`,
 * `reasonerBackendByRun`). Cleared by `clearIntentForRun(runId)` from
 * the terminal-cleanup path in `tool-result.ts`.
 *
 * Stays in-process (no DB) on purpose — the value only matters for
 * the lifetime of the run.
 */

import type { IntentHint } from "../reasoning/intent-classifier.js"

const intentByRun = new Map<string, IntentHint>()

/** Store the resolved intent for a run. Idempotent: re-writes are
 *  no-ops when the value is the same (classification is stable for a
 *  run). Empty/missing runId is a no-op so callers can pass an
 *  optional id without guarding. */
export function setIntentForRun(runId: string | null | undefined, hint: IntentHint): void {
  if (!runId) return
  intentByRun.set(runId, hint)
}

/** Read the cached intent. Returns `null` when nothing has been
 *  stashed yet — caller decides whether to classify or fall back. */
export function getIntentForRun(runId: string | null | undefined): IntentHint | null {
  if (!runId) return null
  return intentByRun.get(runId) ?? null
}

/** Drop the cached intent. Called from the terminal-cleanup path so a
 *  new run on the same handler doesn't see a stale classification. */
export function clearIntentForRun(runId: string | null | undefined): void {
  if (!runId) return
  intentByRun.delete(runId)
}

/** Test-only helper. */
export function _resetIntentCacheForTests(): void {
  intentByRun.clear()
}
