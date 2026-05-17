/**
 * Stage 3 of `2026-05-16-awareness-and-verification-correctness.md`.
 *
 * Synthesizes the `waiting_for_user` envelope that the cli's
 * off-course modal listens for. Used by BOTH:
 *
 *   - the per-step divergence path in `tool-result.ts` (every
 *     tool-result turn, log-only pre-Stage-3), AND
 *   - the chunked-loop boundary path (every chunk completion).
 *
 * Before this stage the synthesis was inlined ONLY in the chunked-loop
 * path. The per-step path logged `state=blocked` but never
 * short-circuited the response, so the cli kept executing turns even
 * when confidence had dropped past the threshold — the user-reported
 * bug: *"state=blocked in logs but the agent kept executing"*.
 *
 * Centralising the synthesis means both paths produce IDENTICAL
 * envelopes, which (a) makes the cli render path deterministic
 * regardless of which detector fired and (b) lets us pin the
 * envelope shape with a Zod-style assertion in tests.
 *
 * Pure — no I/O, no state. All inputs flow through the argument.
 */

import { mapNormalizedResponseToClient } from "../providers/normalize.js"
import type { ClientResponse, NormalizedResponse } from "../types.js"
import type { DivergenceSignal } from "./divergence-detector.js"

export type AwarenessHaltSource = "per_step" | "chunk_boundary"

export interface AwarenessLlmVerdictSummary {
  mismatches: string[]
  suggestion: "continue" | "pause" | "backtrack"
  score: number
}

export interface AwarenessHaltInputs {
  runId: string
  /** Per-run confidence score at halt time (0-100). */
  confidence: number
  /** Signals contributing to the confidence drop. The most recent 6 are surfaced. */
  signals: ReadonlyArray<DivergenceSignal>
  /**
   * Cached LLM divergence verdict, if any. Only the chunk-boundary
   * path normally has this; the per-step path passes null. The cli
   * renders the mismatches list when present.
   */
  lastLlmVerdict: AwarenessLlmVerdictSummary | null
  /**
   * Chunk index to roll back to if the user chooses "backtrack".
   * The cli's `rollbackToChunk` is best-effort — passing -1 just
   * means "no snapshot to restore" and the cli warns rather than
   * failing. Useful default for the per-step path when no chunks
   * have started yet.
   */
  lastGoodChunkIndex: number
  /** Which detector triggered the halt. Surfaced to the cli for telemetry. */
  source: AwarenessHaltSource
}

/**
 * Build the off-course-modal envelope.
 *
 * Shape (CLI-observable):
 *
 *   status: "waiting_for_user"
 *   runId: string
 *   message: string
 *   awarenessChoice: true
 *   awarenessEvidence: {
 *     confidence: number
 *     signals: Array<{ category, detail, severity }>   // last 6
 *     lastLlmVerdict: { mismatches, suggestion, score } | null
 *     lastGoodChunkIndex: number
 *     source: "per_step" | "chunk_boundary"
 *   }
 *
 * The cli's response loop branches on `awarenessChoice === true` and
 * routes to `askOffCourse` instead of the generic free-text askUser.
 * Pinned by `awareness-halt-synthesis.test.ts`.
 */
export function synthesizeAwarenessHaltResponse(input: AwarenessHaltInputs): ClientResponse {
  const message = `Confidence dropped to ${Math.round(input.confidence)}/100 — I think the run drifted from your ask. What should I do?`
  const synthesised: NormalizedResponse = {
    kind: "waiting_for_user",
    content: message,
    usage: { inputTokens: 0, outputTokens: 0 },
  }
  const resp = mapNormalizedResponseToClient(input.runId, synthesised) as unknown as Record<string, unknown>
  resp.awarenessChoice = true
  resp.awarenessEvidence = {
    confidence: input.confidence,
    signals: input.signals.slice(-6).map((s) => ({
      category: s.category,
      detail: s.detail,
      severity: s.severity ?? null,
    })),
    lastLlmVerdict: input.lastLlmVerdict,
    lastGoodChunkIndex: input.lastGoodChunkIndex,
    source: input.source,
  }
  return resp as unknown as ClientResponse
}
