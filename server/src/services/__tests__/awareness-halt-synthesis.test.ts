/**
 * Stage 3 of `2026-05-16-awareness-and-verification-correctness.md`.
 *
 * Pins the off-course-modal envelope shape. The cli's response loop
 * branches on `awarenessChoice === true` inside the `waiting_for_user`
 * case (cli-client/src/agent/agent.ts:967) — if this envelope drifts,
 * the cli falls back to the generic askUser prompt and the off-course
 * modal silently stops firing. That's exactly the regression Stage 3
 * fixes.
 */

import { describe, it, expect } from "vitest"
import {
  synthesizeAwarenessHaltResponse,
  type AwarenessHaltInputs,
} from "../awareness-halt-synthesis.js"
import type { DivergenceSignal } from "../divergence-detector.js"

function makeSignal(over: Partial<DivergenceSignal> = {}): DivergenceSignal {
  return {
    category: "intent_keyword_absent",
    detail: "user asked for postgres but no related files found",
    severity: "major",
    ...over,
  }
}

function makeInputs(over: Partial<AwarenessHaltInputs> = {}): AwarenessHaltInputs {
  return {
    runId: "run-test",
    confidence: 25,
    signals: [makeSignal()],
    lastLlmVerdict: null,
    lastGoodChunkIndex: 2,
    source: "chunk_boundary",
    ...over,
  }
}

describe("synthesizeAwarenessHaltResponse — envelope shape", () => {
  it("produces a waiting_for_user response with awarenessChoice: true", () => {
    const resp = synthesizeAwarenessHaltResponse(makeInputs())
    const r = resp as unknown as Record<string, unknown>
    expect(r.status).toBe("waiting_for_user")
    expect(r.awarenessChoice).toBe(true)
    expect(r.runId).toBe("run-test")
  })

  it("carries the rounded confidence into the user-visible message", () => {
    const resp = synthesizeAwarenessHaltResponse(makeInputs({ confidence: 27.4 }))
    const r = resp as unknown as Record<string, unknown>
    expect(typeof r.message).toBe("string")
    // Rounded to 27 — pre-Stage-3 the same Math.round was inlined.
    expect((r.message as string)).toContain("27/100")
  })

  it("includes the last 6 signals (most recent slice) with normalized severity", () => {
    const signals: DivergenceSignal[] = []
    for (let i = 0; i < 10; i++) {
      signals.push(makeSignal({ detail: `signal-${i}`, severity: undefined }))
    }
    const resp = synthesizeAwarenessHaltResponse(makeInputs({ signals }))
    const evidence = (resp as unknown as Record<string, unknown>).awarenessEvidence as Record<string, unknown>
    const evSignals = evidence.signals as Array<{ category: string; detail: string; severity: string | null }>
    expect(evSignals).toHaveLength(6)
    // Most recent slice: signals 4-9.
    expect(evSignals[0].detail).toBe("signal-4")
    expect(evSignals[5].detail).toBe("signal-9")
    // Missing severity normalises to null (not undefined — JSON-friendly).
    expect(evSignals[0].severity).toBeNull()
  })

  it("preserves explicit severity on the surfaced signals", () => {
    const resp = synthesizeAwarenessHaltResponse(
      makeInputs({
        signals: [
          makeSignal({ severity: "moderate", category: "same_file_edited_repeatedly", detail: "looped" }),
        ],
      }),
    )
    const evidence = (resp as unknown as Record<string, unknown>).awarenessEvidence as Record<string, unknown>
    const evSignals = evidence.signals as Array<{ category: string; severity: string | null }>
    expect(evSignals[0].severity).toBe("moderate")
  })

  it("carries the lastLlmVerdict verbatim when present", () => {
    const verdict = {
      mismatches: ["asked for postgres but writing mongodb", "scope creep on chunk 3"],
      suggestion: "backtrack" as const,
      score: 32,
    }
    const resp = synthesizeAwarenessHaltResponse(makeInputs({ lastLlmVerdict: verdict }))
    const evidence = (resp as unknown as Record<string, unknown>).awarenessEvidence as Record<string, unknown>
    expect(evidence.lastLlmVerdict).toEqual(verdict)
  })

  it("normalizes lastLlmVerdict to null (not undefined) when absent — cli can JSON.stringify safely", () => {
    const resp = synthesizeAwarenessHaltResponse(makeInputs({ lastLlmVerdict: null }))
    const evidence = (resp as unknown as Record<string, unknown>).awarenessEvidence as Record<string, unknown>
    expect(evidence.lastLlmVerdict).toBeNull()
    // Round-trip through JSON to prove cli serialization works.
    const json = JSON.stringify(resp)
    expect(json).toContain("\"lastLlmVerdict\":null")
  })

  it("threads lastGoodChunkIndex into evidence so cli backtrack knows where to roll to", () => {
    const resp = synthesizeAwarenessHaltResponse(makeInputs({ lastGoodChunkIndex: 4 }))
    const evidence = (resp as unknown as Record<string, unknown>).awarenessEvidence as Record<string, unknown>
    expect(evidence.lastGoodChunkIndex).toBe(4)
  })

  it("accepts lastGoodChunkIndex=-1 (no chunks started — per-step early halt)", () => {
    const resp = synthesizeAwarenessHaltResponse(
      makeInputs({ source: "per_step", lastGoodChunkIndex: -1 }),
    )
    const evidence = (resp as unknown as Record<string, unknown>).awarenessEvidence as Record<string, unknown>
    expect(evidence.lastGoodChunkIndex).toBe(-1)
    expect(evidence.source).toBe("per_step")
  })

  it("surfaces the detector source so cli telemetry can distinguish per_step vs chunk_boundary halts", () => {
    const perStep = synthesizeAwarenessHaltResponse(makeInputs({ source: "per_step" }))
    const chunkBoundary = synthesizeAwarenessHaltResponse(makeInputs({ source: "chunk_boundary" }))
    expect((perStep as unknown as Record<string, unknown>).awarenessEvidence).toMatchObject({ source: "per_step" })
    expect((chunkBoundary as unknown as Record<string, unknown>).awarenessEvidence).toMatchObject({ source: "chunk_boundary" })
  })

  it("survives JSON round-trip with all fields intact (cli wire-format contract)", () => {
    const resp = synthesizeAwarenessHaltResponse(
      makeInputs({
        confidence: 25,
        signals: [
          makeSignal({ category: "intent_keyword_absent", detail: "missing postgres", severity: "major" }),
          makeSignal({ category: "same_file_edited_repeatedly", detail: "src/db.ts edited 4x", severity: "moderate" }),
        ],
        lastLlmVerdict: { mismatches: ["x"], suggestion: "pause", score: 40 },
        lastGoodChunkIndex: 1,
        source: "chunk_boundary",
      }),
    )
    const decoded = JSON.parse(JSON.stringify(resp)) as Record<string, unknown>
    expect(decoded.status).toBe("waiting_for_user")
    expect(decoded.awarenessChoice).toBe(true)
    const evidence = decoded.awarenessEvidence as Record<string, unknown>
    expect(evidence.confidence).toBe(25)
    expect((evidence.signals as unknown[]).length).toBe(2)
    expect(evidence.lastGoodChunkIndex).toBe(1)
    expect(evidence.source).toBe("chunk_boundary")
  })
})
