/**
 * Stage 5 of `2026-05-16-awareness-and-verification-correctness.md`.
 *
 * Per-run counter for `intent_keyword_absent` heuristic satisfactions.
 * Stage 2 widened the satisfaction check from path-only (Tier 1) to
 * also include package.json + framework-file structural signals
 * (Tier 2) and content-snippet word-boundary scan (Tier 3). This
 * counter tells us how often the new tiers do useful work:
 *
 *   - `structuralMatches` — keyword satisfied via package.json deps
 *     or framework-specific file path.
 *   - `contentMatches` — keyword satisfied via the content-snippet
 *     scan (only fires when Tier 1 + Tier 2 both miss).
 *
 * Spike on either counter on a healthy run = Stage 2 IS the reason
 * the heuristic stayed quiet (i.e. we're avoiding the false-positive
 * the user reported). Zero on a clean Tier-1-satisfying run is fine
 * — keywords appeared in file paths and nothing else was needed.
 *
 * Surfaced to the cli via the response envelope marker
 * `_intentKeywordContentMatches` (numbers picked up by normalize.ts).
 * Cli records the peak in RunSummary.
 *
 * Cleared with the rest of the run's per-run state at terminal-exit.
 * Pure module — module-scoped Map, no I/O.
 */

interface IntentMatchCounters {
  structuralMatches: number
  contentMatches: number
}

const counters = new Map<string, IntentMatchCounters>()

export type IntentMatchTier = "structural" | "content"

function ensure(runId: string): IntentMatchCounters {
  let c = counters.get(runId)
  if (!c) {
    c = { structuralMatches: 0, contentMatches: 0 }
    counters.set(runId, c)
  }
  return c
}

export function bumpIntentMatch(runId: string, tier: IntentMatchTier): void {
  if (!runId) return
  const c = ensure(runId)
  if (tier === "structural") c.structuralMatches += 1
  else if (tier === "content") c.contentMatches += 1
}

export function getIntentMatchCounters(runId: string): IntentMatchCounters {
  return counters.get(runId) ?? { structuralMatches: 0, contentMatches: 0 }
}

/**
 * The sum the cli surfaces as `intentKeywordContentMatches` in
 * RunSummary. "Content matches" in the cli-facing name covers BOTH
 * Tier 2 (structural) AND Tier 3 (content) since both are Stage 2
 * additions; the cli treats them as one rollup. The split is
 * preserved server-side via `getIntentMatchCounters` for debugging.
 */
export function getIntentMatchTotal(runId: string): number {
  const c = counters.get(runId)
  if (!c) return 0
  return c.structuralMatches + c.contentMatches
}

export function clearIntentMatchTelemetry(runId: string): void {
  counters.delete(runId)
}

export function _resetIntentMatchStoreForTests(): void {
  counters.clear()
}
