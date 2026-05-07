/**
 * Confidence tracker — per-run score that decays as the divergence detector
 * fires signals. Pure in-memory, mirrors `chunk-state.ts`'s shape.
 *
 * Score starts at 100, drops by a per-category weight each time a signal
 * fires. Threshold state is a derived view: 'on_track' (>= off_course),
 * 'off_course' (>= blocked), or 'blocked' (< blocked). Threshold values are
 * read at evaluation time via the flag system so live tuning works without
 * a tracker reset.
 *
 * Cleared by `clearConfidence(runId)` when the run terminates (paired with
 * `clearChunkState` and `clearPipeline` in `tool-result.ts`).
 */

import type { DivergenceCategory, DivergenceSignal } from "./divergence-detector.js"
import { isFreeTierModel, FREE_MODEL_SENSITIVITY_BUMP } from "./free-tier-policy.js"

// Phase 16 Stage 1: `isFreeTierModel` and `FREE_MODEL_SENSITIVITY_BUMP`
// moved to `free-tier-policy.ts`. Re-exported here so existing importers
// (tests, future callers) keep working while the module is the new source
// of truth.
export { isFreeTierModel, FREE_MODEL_SENSITIVITY_BUMP }
import { getFlag } from "./flags.js"

export type ThresholdState = "on_track" | "off_course" | "blocked"

export interface ConfidenceState {
  runId: string
  score: number
  /** All signals recorded during the run, oldest first. */
  signals: DivergenceSignal[]
  /** When `recordSignals` last ran (millis). 0 if never. */
  lastUpdated: number
}

/**
 * Per-category decay weight. A signal with severity "major" deducts more —
 * see `severityMultiplier` below. Tuned conservatively: even the heaviest
 * single signal can't drop a fresh run from on_track to blocked in one fire,
 * so the user sees a yellow ⚠ before a red ✖.
 */
const CATEGORY_WEIGHT: Record<DivergenceCategory, number> = {
  intent_keyword_absent: 25,            // user asked for X, no X anywhere — biggest macro signal
  completion_claims_unwritten_files: 20, // model lying about its output — high stakes
  same_file_edited_repeatedly: 12,       // stuck-loop signal
  repeated_tool_error: 12,               // not recovering
  scope_creep: 8,                        // chunk count overshoot — softer
  mkdir_empty_at_chunk_boundary: 5,      // common during scaffold; weakest
  llm_off_track: 25,                     // Phase 11 Stage 3: Flash second-opinion verdict — same heft as keyword-absent
}

function severityMultiplier(sev: DivergenceSignal["severity"]): number {
  if (sev === "major") return 1.0
  if (sev === "minor") return 0.5
  return 0.75 // moderate or undefined
}

const states = new Map<string, ConfidenceState>()

/** Initial score; exported for tests. */
export const INITIAL_SCORE = 100

function ensureState(runId: string): ConfidenceState {
  let s = states.get(runId)
  if (!s) {
    s = { runId, score: INITIAL_SCORE, signals: [], lastUpdated: 0 }
    states.set(runId, s)
  }
  return s
}

/**
 * Apply one round of detector output to the run's score. Idempotent in the
 * sense that an empty array is a no-op; *not* idempotent across calls — each
 * call deducts again, so the caller (tool-result seam) is responsible for
 * not re-feeding the same signals from a prior chunk.
 *
 * Returns the post-deduction score for convenience.
 */
export function recordSignals(runId: string, signals: DivergenceSignal[]): number {
  const s = ensureState(runId)
  if (signals.length === 0) {
    s.lastUpdated = Date.now()
    return s.score
  }
  for (const sig of signals) {
    const base = CATEGORY_WEIGHT[sig.category] ?? 10
    const delta = base * severityMultiplier(sig.severity)
    s.score = Math.max(0, s.score - delta)
    s.signals.push(sig)
  }
  s.lastUpdated = Date.now()
  return s.score
}

/** Current confidence (0-100). Returns INITIAL_SCORE for unknown runs. */
export function getConfidence(runId: string): number {
  return states.get(runId)?.score ?? INITIAL_SCORE
}

/** Full per-run state snapshot, or null if the run hasn't been touched. */
export function getConfidenceState(runId: string): ConfidenceState | null {
  return states.get(runId) ?? null
}

/**
 * Map the current score to a coarse state. Threshold values come from the
 * flag system so they can be tuned per-deployment without code changes:
 *   awareness.threshold_off_course (default 60)
 *   awareness.threshold_blocked    (default 30)
 *
 * `sysbasePath` is forwarded so flags.json overrides are respected.
 *
 * Phase 11 Stage 7: when `model` matches the free-tier model regex
 * (openrouter-auto / llama / mistral / gemini-flash-or), both thresholds
 * rise by `FREE_MODEL_SENSITIVITY_BUMP` (default +10), making the awareness
 * loop trip earlier on free models — they're the ones that commit to a
 * wrong direction at chunk 1 and ride it to the end (the original bug
 * Phase 11 was designed to catch).
 */
export function getThresholdState(runId: string, sysbasePath?: string | null, model?: string | null): ThresholdState {
  const score = getConfidence(runId)
  let offCourseAt = 60
  let blockedAt = 30
  try { offCourseAt = getFlag<number>("awareness.threshold_off_course", sysbasePath) } catch {}
  try { blockedAt = getFlag<number>("awareness.threshold_blocked", sysbasePath) } catch {}
  if (model && isFreeTierModel(model)) {
    offCourseAt += FREE_MODEL_SENSITIVITY_BUMP
    blockedAt += FREE_MODEL_SENSITIVITY_BUMP
  }
  if (score < blockedAt) return "blocked"
  if (score < offCourseAt) return "off_course"
  return "on_track"
}

/** Wipe a run's state. Called from the same teardown path as `clearChunkState`. */
export function clearConfidence(runId: string): void {
  states.delete(runId)
}

/** Test-only: blow away every run's state. */
export function _resetForTests(): void {
  states.clear()
}
