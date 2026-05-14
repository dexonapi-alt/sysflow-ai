import { describe, it, expect } from "vitest"
import { shouldFallback } from "../adapter.js"
import { MODEL_FALLBACK_CHAINS } from "../base-provider.js"

describe("shouldFallback — Stage A lock-in decision", () => {
  describe("when lock-in is enabled (default)", () => {
    it("returns false for explicit Anthropic picks", () => {
      expect(shouldFallback("claude-sonnet", true)).toBe(false)
      expect(shouldFallback("claude-opus", true)).toBe(false)
    })

    it("returns false for explicit Gemini picks", () => {
      expect(shouldFallback("gemini-flash", true)).toBe(false)
      expect(shouldFallback("gemini-pro", true)).toBe(false)
    })

    it("returns false for explicit OpenRouter free-model picks", () => {
      expect(shouldFallback("llama-70b", true)).toBe(false)
      expect(shouldFallback("mistral-small", true)).toBe(false)
    })

    it("returns true for openrouter-auto (the only auto pick)", () => {
      expect(shouldFallback("openrouter-auto", true)).toBe(true)
    })

    it("returns true for any future *-auto pick", () => {
      expect(shouldFallback("anthropic-auto", true)).toBe(true)
      expect(shouldFallback("gemini-auto", true)).toBe(true)
    })
  })

  describe("when lock-in is disabled (legacy behaviour)", () => {
    it("returns true for every model — pre-Stage-A behaviour", () => {
      expect(shouldFallback("claude-sonnet", false)).toBe(true)
      expect(shouldFallback("claude-opus", false)).toBe(true)
      expect(shouldFallback("gemini-flash", false)).toBe(true)
      expect(shouldFallback("gemini-pro", false)).toBe(true)
      expect(shouldFallback("llama-70b", false)).toBe(true)
      expect(shouldFallback("mistral-small", false)).toBe(true)
      expect(shouldFallback("openrouter-auto", false)).toBe(true)
    })
  })
})

describe("MODEL_FALLBACK_CHAINS — Stage A trimming", () => {
  it("has empty chains for explicit Anthropic picks", () => {
    expect(MODEL_FALLBACK_CHAINS["claude-sonnet"]).toEqual([])
    expect(MODEL_FALLBACK_CHAINS["claude-opus"]).toEqual([])
  })

  it("has empty chains for explicit Gemini picks", () => {
    expect(MODEL_FALLBACK_CHAINS["gemini-flash"]).toEqual([])
    expect(MODEL_FALLBACK_CHAINS["gemini-pro"]).toEqual([])
  })

  it("has empty chains for explicit OpenRouter free-model picks", () => {
    expect(MODEL_FALLBACK_CHAINS["llama-70b"]).toEqual([])
    expect(MODEL_FALLBACK_CHAINS["mistral-small"]).toEqual([])
  })

  it("keeps openrouter-auto's chain because the auto suffix expects cycling", () => {
    expect(MODEL_FALLBACK_CHAINS["openrouter-auto"]).toEqual(["gemini-flash", "mistral-small"])
  })

  it("leaves swe untouched (out of scope per plan)", () => {
    expect(MODEL_FALLBACK_CHAINS["swe"]).toEqual(["gemini-pro", "gemini-flash"])
  })
})
