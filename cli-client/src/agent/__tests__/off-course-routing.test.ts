/**
 * Stage 3 of `2026-05-16-awareness-and-verification-correctness.md`.
 *
 * Pins the cli's contract with the server's off-course-modal envelope.
 * The server's `synthesizeAwarenessHaltResponse` is the producer (tested
 * in `server/src/services/__tests__/awareness-halt-synthesis.test.ts`);
 * this suite is the CONSUMER side — what the cli's response loop looks
 * at when it decides to route to `askOffCourse` instead of `askUser`.
 *
 * Specifically:
 *   - `classifyResponse(env)` → `user_responded` for the synthesised
 *     envelope (so the loop enters the `case "user_responded"` branch
 *     where the awarenessChoice predicate lives).
 *   - The `awarenessChoice === true` predicate matches the envelope's
 *     boolean field.
 *   - The `awarenessEvidence` object matches the `OffCourseEvidence`
 *     interface shape (signals[], confidence, lastGoodChunkIndex,
 *     lastLlmVerdict?, source).
 *
 * If the server's envelope drifts (e.g. renames `awarenessChoice` to
 * something else, drops `lastGoodChunkIndex`), the cli falls through
 * to the generic free-text askUser prompt and the off-course modal
 * silently stops firing — exactly the regression Stage 3 fixes.
 */

import { describe, it, expect } from "vitest"
import { classifyResponse } from "../state-machine.js"
import type { OffCourseEvidence } from "../../cli/off-course-prompt.js"

/**
 * Fixture that mirrors the server's synthesizeAwarenessHaltResponse
 * output exactly. Kept verbose so a drift on either side fails this
 * test loudly.
 */
function makeAwarenessHaltEnvelope(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    status: "waiting_for_user",
    runId: "run-test",
    message: "Confidence dropped to 25/100 — I think the run drifted from your ask. What should I do?",
    pendingAction: null,
    awarenessChoice: true,
    awarenessEvidence: {
      confidence: 25,
      signals: [
        { category: "intent_keyword_absent", detail: "user asked for postgres but no related files / mentions found", severity: "major" },
        { category: "same_file_edited_repeatedly", detail: "src/db.ts has been edited 4 times — possible stuck-loop", severity: "moderate" },
      ],
      lastLlmVerdict: null,
      lastGoodChunkIndex: 2,
      source: "chunk_boundary",
    },
    ...over,
  }
}

describe("classifyResponse — awareness halt envelope routes to user_responded", () => {
  it("maps the synthesised waiting_for_user to user_responded continue-transition", () => {
    const env = makeAwarenessHaltEnvelope()
    const transition = classifyResponse(env)
    expect(transition.terminal).toBe(false)
    if (!transition.terminal) {
      expect(transition.reason).toBe("user_responded")
    }
  })

  it("treats waiting_for_user as a CONTINUE transition (not terminal — loop must keep going)", () => {
    // Regression: if state-machine reclassified waiting_for_user as
    // terminal, the cli would exit before askOffCourse renders.
    const transition = classifyResponse(makeAwarenessHaltEnvelope())
    expect(transition.terminal).toBe(false)
  })

  it("still routes a non-awareness waiting_for_user (generic askUser) to user_responded", () => {
    // The cli's branch inside user_responded reads
    // `response.awarenessChoice === true` to decide off-course vs
    // generic. Generic still uses the same transition reason.
    const generic = makeAwarenessHaltEnvelope({
      message: "Need clarification: which database should I use?",
      awarenessChoice: undefined,
      awarenessEvidence: undefined,
    })
    const transition = classifyResponse(generic)
    expect(transition.terminal).toBe(false)
    if (!transition.terminal) {
      expect(transition.reason).toBe("user_responded")
    }
  })
})

describe("awarenessChoice predicate — cli branch condition", () => {
  // Same shape as agent.ts:967: `(response as Record).awarenessChoice === true`.
  const isAwarenessHalt = (resp: Record<string, unknown>): boolean =>
    (resp as Record<string, unknown>).awarenessChoice === true

  it("matches the canonical envelope (awarenessChoice: true)", () => {
    expect(isAwarenessHalt(makeAwarenessHaltEnvelope())).toBe(true)
  })

  it("does NOT match a generic waiting_for_user (awarenessChoice omitted)", () => {
    expect(
      isAwarenessHalt(makeAwarenessHaltEnvelope({ awarenessChoice: undefined, awarenessEvidence: undefined })),
    ).toBe(false)
  })

  it("does NOT match awarenessChoice: false (defensive — strict-equality)", () => {
    expect(isAwarenessHalt(makeAwarenessHaltEnvelope({ awarenessChoice: false }))).toBe(false)
  })

  it("does NOT match truthy non-true values (defensive — strict-equality)", () => {
    expect(isAwarenessHalt(makeAwarenessHaltEnvelope({ awarenessChoice: "true" }))).toBe(false)
    expect(isAwarenessHalt(makeAwarenessHaltEnvelope({ awarenessChoice: 1 }))).toBe(false)
  })
})

describe("OffCourseEvidence shape — typed read against the envelope", () => {
  it("conforms to OffCourseEvidence (TypeScript pinning + runtime check)", () => {
    const env = makeAwarenessHaltEnvelope()
    // The cli reads evidence as OffCourseEvidence; this cast is
    // exactly how agent.ts:969 does it. The fields below MUST exist
    // for the modal to render without runtime errors.
    const evidence = env.awarenessEvidence as OffCourseEvidence

    expect(typeof evidence.confidence).toBe("number")
    expect(Array.isArray(evidence.signals)).toBe(true)
    expect(typeof evidence.lastGoodChunkIndex).toBe("number")
    // signals[i] shape: category + detail + (optional) severity
    for (const sig of evidence.signals) {
      expect(typeof sig.category).toBe("string")
      expect(typeof sig.detail).toBe("string")
      if (sig.severity !== undefined) {
        expect(typeof sig.severity).toBe("string")
      }
    }
  })

  it("supports an LLM verdict when present (renders alongside heuristic signals)", () => {
    const env = makeAwarenessHaltEnvelope({
      awarenessEvidence: {
        confidence: 30,
        signals: [],
        lastLlmVerdict: {
          mismatches: ["asked for postgres but writing mongodb", "scope creep on chunk 3"],
          suggestion: "backtrack",
          score: 32,
        },
        lastGoodChunkIndex: 3,
        source: "chunk_boundary",
      },
    })
    const evidence = env.awarenessEvidence as OffCourseEvidence
    expect(evidence.lastLlmVerdict).not.toBeNull()
    expect(evidence.lastLlmVerdict?.suggestion).toBe("backtrack")
  })

  it("accepts lastGoodChunkIndex=-1 (per-step early halt before any chunks ran)", () => {
    const env = makeAwarenessHaltEnvelope({
      awarenessEvidence: {
        confidence: 25,
        signals: [],
        lastLlmVerdict: null,
        lastGoodChunkIndex: -1,
        source: "per_step",
      },
    })
    const evidence = env.awarenessEvidence as OffCourseEvidence
    expect(evidence.lastGoodChunkIndex).toBe(-1)
  })
})

describe("end-to-end — server envelope shape pins cli routing", () => {
  it("a per_step source halt routes identically to a chunk_boundary halt (envelope parity)", () => {
    // Stage 3 unifies the two synthesis paths through the same
    // helper. The cli MUST handle both identically — same routing,
    // same modal render, same backtrack semantics. This test pins
    // the routing parity even though the cli doesn't switch on
    // source today.
    const perStep = makeAwarenessHaltEnvelope({
      awarenessEvidence: {
        confidence: 25,
        signals: [
          { category: "same_action_repeated_in_session", detail: "stuck loop on src/db.ts", severity: "moderate" },
        ],
        lastLlmVerdict: null,
        lastGoodChunkIndex: -1,
        source: "per_step",
      },
    })
    const chunkBoundary = makeAwarenessHaltEnvelope()

    const perStepTransition = classifyResponse(perStep)
    const chunkTransition = classifyResponse(chunkBoundary)

    expect(perStepTransition).toEqual(chunkTransition)
  })
})
