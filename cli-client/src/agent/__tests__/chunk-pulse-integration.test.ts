/**
 * Plan `2026-05-18-chunk-pulse-missing-diagnostic.md` Stage 2 integration
 * test (the Stage 3 plan called for a defensive end-to-end test — this
 * lands it early so Stage 2's analysis has a tested baseline).
 *
 * Walks the FULL cli-side path:
 *
 *     server response shape (mocked)
 *         → chunkPlanEventFromResponse (event extraction)
 *         → reduceAgentEvent (state mutation)
 *         → chunkRenderMode (render decision)
 *
 * If every step in this chain works in isolation but the user still
 * doesn't see `▸ N` in the Header, the bug is upstream: the server
 * isn't attaching `chunkPlanBrief` to the response that reaches the
 * cli. (Stage 1's `[chunk-pulse-diag]` logs at the actual call sites
 * pin which side of the wire the field is missing on.)
 *
 * Pre-Stage-2 the existing tests covered the reducer (`useAgentEvents.test.ts`)
 * and the helper (`Header.test.ts: chunkRenderMode`) in isolation — but
 * no test walked the contract end-to-end. A regression at the
 * extraction step or a payload-shape drift would have slipped past
 * both isolated tests.
 */

import { describe, it, expect } from "vitest"
import { chunkPlanEventFromResponse } from "../chunk-plan-event.js"
import { reduceAgentEvent, type AgentEventState } from "../../ui/hooks/useAgentEvents.js"
import { chunkRenderMode } from "../../ui/components/Header.js"

const INITIAL_STATE: AgentEventState = {
  log: [],
  spinnerText: null,
  toolCards: [],
  awareness: null,
  chunk: null,
  assistantMessage: null,
  reasoningBrief: null,
  runStartedAt: null,
  runIntent: null,
  infraError: null,
  activeModal: null,
  streamPreview: null,
}

/** Build a fake `needs_tool` server response with an attached chunkPlanBrief. */
function responseWithChunkPlan(
  nextAction: string,
  files: string[] = ["src/models.ts", "src/db.ts"],
): Record<string, unknown> {
  return {
    status: "needs_tool",
    runId: "test-run",
    tool: "write_file",
    args: { path: "src/models.ts", content: "..." },
    chunkPlanBrief: { nextAction, files },
  }
}

describe("chunk-pulse end-to-end: server response → header render mode", () => {
  it("the happy path: chunkPlanBrief present + ink active + implement run → implement-pulse", () => {
    const response = responseWithChunkPlan("write models")
    const event = chunkPlanEventFromResponse(response, 1, true)
    expect(event).not.toBeNull()
    expect(event!.type).toBe("chunk_plan")

    const state = reduceAgentEvent(INITIAL_STATE, event!)
    expect(state.chunk).not.toBeNull()
    expect(state.chunk!.index).toBe(1)
    expect(state.chunk!.nextAction).toBe("write models")
    expect(state.chunk!.fileCount).toBe(2)
    expect(state.chunk!.pulseKey).toBe(1)

    const mode = chunkRenderMode(state.chunk !== null, state.runIntent)
    expect(mode).toBe("implement-pulse")
  })

  it("falls back to 'hidden' when the response has no chunkPlanBrief (branch a — server didn't attach)", () => {
    const response = { status: "needs_tool", runId: "test-run", tool: "read_file" }
    const event = chunkPlanEventFromResponse(response, 1, true)
    expect(event).toBeNull()

    // No event → state.chunk stays null → mode is hidden.
    expect(chunkRenderMode(false, null)).toBe("hidden")
  })

  it("falls back to 'hidden' when ink is inactive (legacy mode — no Header to push the pulse into)", () => {
    const response = responseWithChunkPlan("wire routes")
    const event = chunkPlanEventFromResponse(response, 1, false)
    expect(event).toBeNull()
  })

  it("rejects briefs with an empty nextAction (defensive — reducer needs a non-empty label)", () => {
    const response = { ...responseWithChunkPlan(""), chunkPlanBrief: { nextAction: "", files: [] } }
    const event = chunkPlanEventFromResponse(response, 1, true)
    expect(event).toBeNull()
  })

  it("rejects briefs with a missing nextAction (defensive — schema enforces this server-side but we re-check at the wire)", () => {
    const response = { ...responseWithChunkPlan("placeholder"), chunkPlanBrief: { files: ["a.ts"] } }
    const event = chunkPlanEventFromResponse(response, 1, true)
    expect(event).toBeNull()
  })

  it("the 7-chunk user-repro: 7 sequential chunk_plan emissions monotonically advance the pulse", () => {
    // Simulate the user's reported scenario — 7 chunk-plan firings server-side.
    // Each turn the cli observes a fresh response, extracts an event, reduces
    // into state. Header should always read `implement-pulse` (chunk present;
    // runIntent stays null for the initial turn, then implement once classified).
    let state = INITIAL_STATE
    for (let i = 1; i <= 7; i++) {
      const response = responseWithChunkPlan(`chunk-${i} action`, [`src/chunk-${i}.ts`])
      const event = chunkPlanEventFromResponse(response, i, true)
      expect(event).not.toBeNull()
      state = reduceAgentEvent(state, event!)
    }
    expect(state.chunk!.index).toBe(7)
    expect(state.chunk!.pulseKey).toBe(7)
    expect(chunkRenderMode(state.chunk !== null, state.runIntent)).toBe("implement-pulse")
  })

  it("with runIntent='simple' after intent_classified, the chunk renders 'internal-indicator' instead of 'implement-pulse'", () => {
    const response = responseWithChunkPlan("write models")
    const chunkEvent = chunkPlanEventFromResponse(response, 1, true)!
    const afterChunk = reduceAgentEvent(INITIAL_STATE, chunkEvent)
    // Intent classifier fires after the first response; mock the event.
    const afterIntent = reduceAgentEvent(afterChunk, { type: "intent_classified", intent: "simple" })
    expect(afterIntent.runIntent).toBe("simple")
    expect(chunkRenderMode(afterIntent.chunk !== null, afterIntent.runIntent)).toBe("internal-indicator")
  })

  it("with runIntent='implement', mode stays 'implement-pulse' (most common case)", () => {
    const response = responseWithChunkPlan("write models")
    const chunkEvent = chunkPlanEventFromResponse(response, 1, true)!
    let state = reduceAgentEvent(INITIAL_STATE, chunkEvent)
    state = reduceAgentEvent(state, { type: "intent_classified", intent: "implement" })
    expect(chunkRenderMode(state.chunk !== null, state.runIntent)).toBe("implement-pulse")
  })

  it("defensive: null / undefined response yields no event (no crash)", () => {
    expect(chunkPlanEventFromResponse(null, 1, true)).toBeNull()
    expect(chunkPlanEventFromResponse(undefined, 1, true)).toBeNull()
  })

  it("chunkPlanEventFromResponse is the SAME helper both agent.ts observer sites call (regression guard against drift)", () => {
    // Pre-Stage-2 the emit logic was inlined at two sites in agent.ts.
    // The two could drift independently; a fix at one site wouldn't
    // propagate. Stage 2 routes both through this helper. The test
    // doesn't import agent.ts (too heavy), but exercises the helper
    // with both shapes — initial-turn and per-turn — to confirm one
    // contract serves both.
    const initialResponse = responseWithChunkPlan("plan chunk 1")
    const perTurnResponse = responseWithChunkPlan("plan chunk 2", ["src/routes.ts"])
    const a = chunkPlanEventFromResponse(initialResponse, 1, true)
    const b = chunkPlanEventFromResponse(perTurnResponse, 2, true)
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
    expect(a!.chunkIndex).toBe(1)
    expect(b!.chunkIndex).toBe(2)
    expect(b!.fileCount).toBe(1)
  })
})
