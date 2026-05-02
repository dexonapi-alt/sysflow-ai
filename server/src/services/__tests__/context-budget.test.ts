import { describe, it, expect } from "vitest"
import {
  estimateTokens,
  applyToolResultBudget,
  microcompactGeminiHistory,
  shouldBlockOnTokens,
  AutocompactCircuitBreaker,
  isInsideAutocompactCall,
  type GeminiContent,
} from "../context-budget.js"

describe("estimateTokens", () => {
  it("returns 0 for null/undefined", () => {
    expect(estimateTokens(null)).toBe(0)
    expect(estimateTokens(undefined)).toBe(0)
  })
  it("counts string length / 4", () => {
    expect(estimateTokens("hello world!")).toBe(3) // 12 / 4
  })
  it("stringifies objects", () => {
    expect(estimateTokens({ a: "ab" })).toBeGreaterThan(0)
  })
  it("handles primitives", () => {
    expect(estimateTokens(12345)).toBe(2) // "12345" → 5 / 4 = 2
    expect(estimateTokens(true)).toBe(1)
  })
})

describe("applyToolResultBudget", () => {
  it("leaves small results untouched", () => {
    const r = applyToolResultBudget("read_file", { path: "x", content: "ok" })
    expect(r._truncated).toBeUndefined()
    expect(r.content).toBe("ok")
  })

  it("truncates the largest string field when over the cap", () => {
    const huge = "x".repeat(60_000)
    const r = applyToolResultBudget("read_file", { path: "x", content: huge })
    expect(r._truncated).toBe(true)
    expect((r.content as string).length).toBeLessThan(huge.length)
    expect(r._original_size).toBe(60_000)
  })

  it("falls back to a generic marker when no string field is large enough", () => {
    // Many small fields totaling > cap
    const flat: Record<string, unknown> = {}
    for (let i = 0; i < 200; i++) flat[`f${i}`] = "x".repeat(200)
    const r = applyToolResultBudget("write_file", flat)  // cap = 5000
    expect(r._truncated).toBe(true)
  })
})

describe("shouldBlockOnTokens", () => {
  it("blocks when above the buffer-adjusted limit", () => {
    expect(shouldBlockOnTokens(2_000_000, "gemini-flash")).toBe(true)
  })
  it("allows under the limit", () => {
    expect(shouldBlockOnTokens(1_000, "gemini-flash")).toBe(false)
  })
})

describe("microcompactGeminiHistory", () => {
  function userTurn(text: string): GeminiContent {
    return { role: "user", parts: [{ text }] }
  }
  function modelTurn(text: string): GeminiContent {
    return { role: "model", parts: [{ text }] }
  }

  it("clears tool-result turns older than the keep window", () => {
    const history: GeminiContent[] = []
    for (let i = 0; i < 10; i++) {
      history.push(userTurn(`Tool result:\n${JSON.stringify({ tool: "read_file", path: `f${i}` })}`))
      history.push(modelTurn(`{"kind":"needs_tool"}`))
    }
    const compacted = microcompactGeminiHistory(history, 3)
    // Last 3 user-tool-result turns survive verbatim, earlier ones get cleared.
    const userTurns = compacted.filter((h) => h.role === "user")
    const survived = userTurns.filter((h) => (h.parts[0]?.text ?? "").startsWith("Tool result"))
    const cleared = userTurns.filter((h) => (h.parts[0]?.text ?? "").includes("cleared by microcompact"))
    expect(survived.length).toBe(3)
    expect(cleared.length).toBe(7)
  })

  it("returns the input unchanged when fewer than keepLastN tool turns", () => {
    const history: GeminiContent[] = [userTurn("Tool result:\n{}"), modelTurn("ok")]
    expect(microcompactGeminiHistory(history, 5)).toEqual(history)
  })
})

describe("AutocompactCircuitBreaker", () => {
  it("opens after 3 consecutive failures", () => {
    const cb = new AutocompactCircuitBreaker()
    expect(cb.isOpen("r")).toBe(false)
    cb.recordFailure("r")
    cb.recordFailure("r")
    expect(cb.isOpen("r")).toBe(false)
    cb.recordFailure("r")
    expect(cb.isOpen("r")).toBe(true)
  })

  it("recordSuccess resets the counter", () => {
    const cb = new AutocompactCircuitBreaker()
    cb.recordFailure("r")
    cb.recordFailure("r")
    cb.recordSuccess("r")
    cb.recordFailure("r") // back to 1
    expect(cb.isOpen("r")).toBe(false)
  })
})

describe("isInsideAutocompactCall", () => {
  it("is false by default", () => {
    expect(isInsideAutocompactCall("r")).toBe(false)
  })
})
