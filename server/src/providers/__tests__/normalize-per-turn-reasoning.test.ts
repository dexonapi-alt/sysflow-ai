/**
 * Plan `2026-05-16-reasoning-chain-provider-parity.md` Stage 1.
 *
 * Tests for the normaliser's per-turn reasoning chain resolution.
 * `resolvePerTurnReasoningChain` is the synthesis path: array wins
 * when present; falls back to singular `reasoning` when the chain is
 * empty/missing; returns undefined when neither is meaningful.
 *
 * The integration tests cover both `needs_tool` and `completed`
 * envelopes — the two surfaces where per-turn deliberation lands.
 */

import { describe, it, expect } from "vitest"
import { resolvePerTurnReasoningChain, classifyPerTurnReasoningSource, mapNormalizedResponseToClient } from "../normalize.js"
import type { NormalizedResponse } from "../../types.js"

const baseUsage = { inputTokens: 0, outputTokens: 0 }

describe("resolvePerTurnReasoningChain", () => {
  it("returns the array verbatim when reasoningChain is non-empty", () => {
    const normalized = {
      kind: "needs_tool",
      tool: "read_file",
      reasoningChain: ["first paragraph", "second paragraph"],
      usage: baseUsage,
    } as unknown as NormalizedResponse
    expect(resolvePerTurnReasoningChain(normalized)).toEqual(["first paragraph", "second paragraph"])
  })

  it("synthesises a single-element chain from singular reasoning when chain is empty", () => {
    const normalized = {
      kind: "needs_tool",
      tool: "read_file",
      reasoning: "The previous tool listed the directory; reading package.json next.",
      reasoningChain: [],
      usage: baseUsage,
    } as unknown as NormalizedResponse
    expect(resolvePerTurnReasoningChain(normalized)).toEqual([
      "The previous tool listed the directory; reading package.json next.",
    ])
  })

  it("synthesises from singular reasoning when chain is missing entirely", () => {
    const normalized = {
      kind: "needs_tool",
      tool: "read_file",
      reasoning: "Reading next.",
      usage: baseUsage,
    } as unknown as NormalizedResponse
    expect(resolvePerTurnReasoningChain(normalized)).toEqual(["Reading next."])
  })

  it("array wins when BOTH are populated (richer signal)", () => {
    const normalized = {
      kind: "needs_tool",
      tool: "read_file",
      reasoning: "fallback string",
      reasoningChain: ["structured paragraph 1", "structured paragraph 2"],
      usage: baseUsage,
    } as unknown as NormalizedResponse
    expect(resolvePerTurnReasoningChain(normalized)).toEqual(["structured paragraph 1", "structured paragraph 2"])
  })

  it("returns undefined when both reasoning and reasoningChain are absent", () => {
    const normalized = {
      kind: "needs_tool",
      tool: "read_file",
      usage: baseUsage,
    } as unknown as NormalizedResponse
    expect(resolvePerTurnReasoningChain(normalized)).toBeUndefined()
  })

  it("returns undefined when reasoning is whitespace-only", () => {
    const normalized = {
      kind: "needs_tool",
      tool: "read_file",
      reasoning: "   \n  \t  ",
      usage: baseUsage,
    } as unknown as NormalizedResponse
    expect(resolvePerTurnReasoningChain(normalized)).toBeUndefined()
  })

  it("returns undefined when reasoning is non-string (defensive)", () => {
    const normalized = {
      kind: "needs_tool",
      tool: "read_file",
      reasoning: 42 as unknown as string,
      usage: baseUsage,
    } as unknown as NormalizedResponse
    expect(resolvePerTurnReasoningChain(normalized)).toBeUndefined()
  })

  it("trims the synthesised paragraph", () => {
    const normalized = {
      kind: "needs_tool",
      tool: "read_file",
      reasoning: "   trimmed paragraph   ",
      usage: baseUsage,
    } as unknown as NormalizedResponse
    expect(resolvePerTurnReasoningChain(normalized)).toEqual(["trimmed paragraph"])
  })

  it("preserves the synthesised paragraph verbatim (no truncation)", () => {
    const long = "x".repeat(500)
    const normalized = {
      kind: "needs_tool",
      tool: "read_file",
      reasoning: long,
      usage: baseUsage,
    } as unknown as NormalizedResponse
    expect(resolvePerTurnReasoningChain(normalized)).toEqual([long])
  })
})

describe("mapNormalizedResponseToClient — needs_tool envelope wiring", () => {
  it("propagates a structured reasoningChain to perTurnReasoningChain", () => {
    const out = mapNormalizedResponseToClient("r1", {
      kind: "needs_tool",
      tool: "read_file",
      args: { path: "x" },
      reasoningChain: ["p1", "p2"],
      usage: baseUsage,
    } as unknown as NormalizedResponse)
    expect(out.perTurnReasoningChain).toEqual(["p1", "p2"])
  })

  it("synthesises perTurnReasoningChain from singular reasoning when chain is empty", () => {
    const out = mapNormalizedResponseToClient("r2", {
      kind: "needs_tool",
      tool: "read_file",
      args: { path: "x" },
      reasoning: "singular paragraph",
      usage: baseUsage,
    } as unknown as NormalizedResponse)
    expect(out.perTurnReasoningChain).toEqual(["singular paragraph"])
  })

  it("leaves perTurnReasoningChain undefined when neither is populated", () => {
    const out = mapNormalizedResponseToClient("r3", {
      kind: "needs_tool",
      tool: "read_file",
      args: { path: "x" },
      usage: baseUsage,
    } as unknown as NormalizedResponse)
    expect(out.perTurnReasoningChain).toBeUndefined()
  })
})

// ─── Stage 4 of reasoning-chain-provider-parity plan: source classifier ───

describe("classifyPerTurnReasoningSource", () => {
  it("returns 'structured' when reasoningChain is non-empty array", () => {
    expect(classifyPerTurnReasoningSource({
      kind: "needs_tool",
      reasoningChain: ["one", "two"],
      usage: baseUsage,
    } as unknown as NormalizedResponse)).toBe("structured")
  })

  it("returns 'synthesised' when only singular reasoning is present", () => {
    expect(classifyPerTurnReasoningSource({
      kind: "needs_tool",
      reasoning: "fallback paragraph",
      usage: baseUsage,
    } as unknown as NormalizedResponse)).toBe("synthesised")
  })

  it("returns 'structured' when BOTH are present (array wins)", () => {
    expect(classifyPerTurnReasoningSource({
      kind: "needs_tool",
      reasoning: "fallback",
      reasoningChain: ["structured"],
      usage: baseUsage,
    } as unknown as NormalizedResponse)).toBe("structured")
  })

  it("returns null when neither is present", () => {
    expect(classifyPerTurnReasoningSource({
      kind: "needs_tool",
      usage: baseUsage,
    } as unknown as NormalizedResponse)).toBeNull()
  })

  it("returns null when reasoning is whitespace-only", () => {
    expect(classifyPerTurnReasoningSource({
      kind: "needs_tool",
      reasoning: "   ",
      usage: baseUsage,
    } as unknown as NormalizedResponse)).toBeNull()
  })

  it("returns null when reasoningChain is empty array AND no reasoning", () => {
    expect(classifyPerTurnReasoningSource({
      kind: "needs_tool",
      reasoningChain: [],
      usage: baseUsage,
    } as unknown as NormalizedResponse)).toBeNull()
  })
})

describe("mapNormalizedResponseToClient — perTurnReasoningSource on needs_tool", () => {
  it("sets perTurnReasoningSource='structured' when array is populated", () => {
    const out = mapNormalizedResponseToClient("r-src-1", {
      kind: "needs_tool",
      tool: "read_file",
      args: { path: "x" },
      reasoningChain: ["p1"],
      usage: baseUsage,
    } as unknown as NormalizedResponse)
    expect(out.perTurnReasoningSource).toBe("structured")
  })

  it("sets perTurnReasoningSource='synthesised' when only singular reasoning is set", () => {
    const out = mapNormalizedResponseToClient("r-src-2", {
      kind: "needs_tool",
      tool: "read_file",
      args: { path: "x" },
      reasoning: "singular",
      usage: baseUsage,
    } as unknown as NormalizedResponse)
    expect(out.perTurnReasoningSource).toBe("synthesised")
  })

  it("sets perTurnReasoningSource=null when neither is set", () => {
    const out = mapNormalizedResponseToClient("r-src-3", {
      kind: "needs_tool",
      tool: "read_file",
      args: { path: "x" },
      usage: baseUsage,
    } as unknown as NormalizedResponse)
    expect(out.perTurnReasoningSource).toBeNull()
  })
})

describe("mapNormalizedResponseToClient — completed envelope wiring", () => {
  it("propagates a structured reasoningChain on completed", () => {
    const out = mapNormalizedResponseToClient("r4", {
      kind: "completed",
      content: "done",
      reasoningChain: ["wrap-up para 1", "wrap-up para 2"],
      usage: baseUsage,
    } as unknown as NormalizedResponse)
    expect(out.perTurnReasoningChain).toEqual(["wrap-up para 1", "wrap-up para 2"])
  })

  it("synthesises on completed when only singular reasoning is set", () => {
    const out = mapNormalizedResponseToClient("r5", {
      kind: "completed",
      content: "done",
      reasoning: "the run wrapped up cleanly",
      usage: baseUsage,
    } as unknown as NormalizedResponse)
    expect(out.perTurnReasoningChain).toEqual(["the run wrapped up cleanly"])
  })

  it("undefined on completed when neither is set", () => {
    const out = mapNormalizedResponseToClient("r6", {
      kind: "completed",
      content: "done",
      usage: baseUsage,
    } as unknown as NormalizedResponse)
    expect(out.perTurnReasoningChain).toBeUndefined()
  })
})
