/**
 * Stage 5 of `2026-05-16-accountability-and-parallel-execution-sequencing.md`.
 *
 * Pure tests for the per-file-reasoning gate. The gate enforces that
 * when the agent emits more than `threshold` tool calls in one
 * batch, the response's `reasoningChain[]` carries at least one
 * paragraph per tool. Pre-Stage-5 the model could ship 11 tools
 * with a single brief paragraph — the user-reported "no
 * accountability per file" pattern.
 */

import { describe, it, expect } from "vitest"
import {
  validatePerFileReasoning,
  buildInsufficientReasoningPrompt,
  MAX_PER_FILE_REASONING_REJECTIONS,
} from "../per-file-reasoning-guard.js"

function arr<T>(n: number, fn: (i: number) => T): T[] {
  return Array.from({ length: n }, (_, i) => fn(i))
}

describe("validatePerFileReasoning — predicate gates", () => {
  it("passes when response kind is not needs_tool", () => {
    expect(validatePerFileReasoning({
      responseKind: "completed",
      tools: arr(10, (i) => ({ tool: "write_file", id: `t${i}`, args: {} })),
      reasoningChain: ["one para"],
      threshold: 3,
    })).toEqual({ ok: true })
  })

  it("passes when tools.length <= threshold (short batch)", () => {
    expect(validatePerFileReasoning({
      responseKind: "needs_tool",
      tools: arr(3, (i) => ({ id: `t${i}` })),
      reasoningChain: ["one"],
      threshold: 3,
    })).toEqual({ ok: true })
  })

  it("passes a 2-tool batch with no reasoning (still within threshold)", () => {
    expect(validatePerFileReasoning({
      responseKind: "needs_tool",
      tools: arr(2, (i) => ({ id: `t${i}` })),
      reasoningChain: [],
      threshold: 3,
    })).toEqual({ ok: true })
  })

  it("rejects when tools > threshold AND reasoning < tools (user repro: 11 tools, 1 paragraph)", () => {
    const result = validatePerFileReasoning({
      responseKind: "needs_tool",
      tools: arr(11, (i) => ({ id: `t${i}` })),
      reasoningChain: ["The agent decided to build the scaffold"],
      threshold: 3,
    })
    expect(result.ok).toBe(false)
    expect(result.toolCount).toBe(11)
    expect(result.reasoningCount).toBe(1)
    expect(result.reason).toBeDefined()
  })

  it("passes when reasoning >= tools (large batch with per-file paragraphs)", () => {
    const result = validatePerFileReasoning({
      responseKind: "needs_tool",
      tools: arr(8, (i) => ({ id: `t${i}` })),
      reasoningChain: arr(8, (i) => `paragraph for tool ${i}`),
      threshold: 3,
    })
    expect(result.ok).toBe(true)
  })

  it("passes when reasoning > tools (over-justified is fine)", () => {
    const result = validatePerFileReasoning({
      responseKind: "needs_tool",
      tools: arr(4, (i) => ({ id: `t${i}` })),
      reasoningChain: arr(10, (i) => `p${i}`),
      threshold: 3,
    })
    expect(result.ok).toBe(true)
  })

  it("ignores empty / whitespace-only paragraphs (filler doesn't count)", () => {
    const result = validatePerFileReasoning({
      responseKind: "needs_tool",
      tools: arr(5, (i) => ({ id: `t${i}` })),
      reasoningChain: ["real paragraph", "", "   ", "\t\n", "another real"],
      threshold: 3,
    })
    expect(result.ok).toBe(false)
    expect(result.reasoningCount).toBe(2)
  })

  it("ignores non-string paragraphs (defensive)", () => {
    const result = validatePerFileReasoning({
      responseKind: "needs_tool",
      tools: arr(5, (i) => ({ id: `t${i}` })),
      reasoningChain: ["real", 42, null, "another real", { foo: "bar" }],
      threshold: 3,
    })
    expect(result.ok).toBe(false)
    expect(result.reasoningCount).toBe(2)
  })

  it("returns ok when tools/reasoning aren't arrays (defensive — treats as empty)", () => {
    expect(validatePerFileReasoning({
      responseKind: "needs_tool",
      tools: undefined,
      reasoningChain: undefined,
      threshold: 3,
    })).toEqual({ ok: true })
    expect(validatePerFileReasoning({
      responseKind: "needs_tool",
      tools: "not an array",
      reasoningChain: "not an array",
      threshold: 3,
    })).toEqual({ ok: true })
  })

  it("respects a higher threshold (e.g. existing-large repos at 5)", () => {
    // 5-tool batch with no reasoning: at threshold 5, passes; at 3, rejects.
    const tools = arr(5, (i) => ({ id: `t${i}` }))
    const noReasoning: string[] = []
    expect(validatePerFileReasoning({ responseKind: "needs_tool", tools, reasoningChain: noReasoning, threshold: 5 })).toEqual({ ok: true })
    expect(validatePerFileReasoning({ responseKind: "needs_tool", tools, reasoningChain: noReasoning, threshold: 3 }).ok).toBe(false)
  })
})

describe("buildInsufficientReasoningPrompt — block contents", () => {
  it("includes INSUFFICIENT REASONING markers", () => {
    const block = buildInsufficientReasoningPrompt(
      { ok: false, reason: "x", toolCount: 11, reasoningCount: 1 },
      3, 1, 3,
    )
    expect(block).toContain("═══ INSUFFICIENT REASONING FOR BATCH ═══")
    expect(block).toContain("═══ END INSUFFICIENT REASONING ═══")
  })

  it("echoes the tool count + reasoning count back to the agent", () => {
    const block = buildInsufficientReasoningPrompt(
      { ok: false, toolCount: 11, reasoningCount: 1 },
      3, 1, 3,
    )
    expect(block).toContain("11 tool calls")
    expect(block).toContain("1 paragraph")
  })

  it("uses singular/plural forms correctly", () => {
    const singular = buildInsufficientReasoningPrompt({ ok: false, toolCount: 5, reasoningCount: 1 }, 3, 1, 3)
    expect(singular).toContain("1 paragraph")
    expect(singular).not.toContain("1 paragraphs")
    const plural = buildInsufficientReasoningPrompt({ ok: false, toolCount: 5, reasoningCount: 2 }, 3, 1, 3)
    expect(plural).toContain("2 paragraphs")
  })

  it("names BOTH escape hatches (reduce batch OR add paragraphs)", () => {
    const block = buildInsufficientReasoningPrompt({ ok: false, toolCount: 8, reasoningCount: 1 }, 3, 1, 3)
    expect(block).toContain("Reduce the batch size to ≤ 3 tool")
    expect(block).toContain("Add reasoning paragraphs")
  })

  it("singular threshold form (threshold=1)", () => {
    const block = buildInsufficientReasoningPrompt({ ok: false, toolCount: 5, reasoningCount: 0 }, 1, 1, 3)
    expect(block).toContain("Reduce the batch size to ≤ 1 tool,")
  })

  it("includes the rejection counter so the agent knows how many retries are left", () => {
    const block = buildInsufficientReasoningPrompt({ ok: false, toolCount: 8, reasoningCount: 1 }, 3, 2, 3)
    expect(block).toContain("rejection 2/3")
  })

  it("defaults toolCount / reasoningCount to 0 if missing (defensive)", () => {
    const block = buildInsufficientReasoningPrompt({ ok: false }, 3, 1, 3)
    expect(block).toContain("0 tool calls")
    expect(block).toContain("0 paragraphs")
  })

  it("JSON-serialises (wire-format check — block is plain text but used as injectContext)", () => {
    const block = buildInsufficientReasoningPrompt({ ok: false, toolCount: 5, reasoningCount: 1 }, 3, 1, 3)
    expect(typeof block).toBe("string")
    expect(block.length).toBeGreaterThan(0)
  })
})

describe("MAX_PER_FILE_REASONING_REJECTIONS — cap matches forced-error-reasoning pattern", () => {
  it("is exactly 3 (same as the error-ack cap; documented in plan)", () => {
    expect(MAX_PER_FILE_REASONING_REJECTIONS).toBe(3)
  })
})

describe("end-to-end — user-reported pattern", () => {
  it("rejects the 11-tool, 1-paragraph scaffold response", () => {
    const result = validatePerFileReasoning({
      responseKind: "needs_tool",
      tools: arr(11, (i) => ({ id: `t${i}`, tool: i < 3 ? "create_directory" : "write_file" })),
      reasoningChain: ["Create the required folder structure and source files for middleware, utilities, and route handlers"],
      threshold: 3,
    })
    expect(result.ok).toBe(false)
    expect(result.toolCount).toBe(11)
    expect(result.reasoningCount).toBe(1)
  })

  it("accepts the same 11 tools when reasoning grows to 11 paragraphs", () => {
    const result = validatePerFileReasoning({
      responseKind: "needs_tool",
      tools: arr(11, (i) => ({ id: `t${i}` })),
      reasoningChain: arr(11, (i) => `Reasoning for tool ${i}: This file is needed because ...`),
      threshold: 3,
    })
    expect(result.ok).toBe(true)
  })

  it("accepts a 3-tool batch with NO reasoning (below threshold)", () => {
    const result = validatePerFileReasoning({
      responseKind: "needs_tool",
      tools: arr(3, (i) => ({ id: `t${i}` })),
      reasoningChain: [],
      threshold: 3,
    })
    expect(result.ok).toBe(true)
  })
})
