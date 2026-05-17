import { describe, it, expect } from "vitest"
import { parseAffordableTokens, classify402Terminal, MEANINGFUL_AFFORDABLE_THRESHOLD } from "../openrouter.js"

describe("parseAffordableTokens", () => {
  it("extracts the affordable number from a real OpenRouter 402 body", () => {
    const body = `{"error":{"message":"This request requires more credits, or fewer max_tokens. You requested up to 32768 tokens, but can only afford 15018. To increase, visit https://openrouter.ai/settings/credits","code":402}}`
    expect(parseAffordableTokens(body)).toBe(15018)
  })

  it("works with a small affordable number", () => {
    expect(parseAffordableTokens("can only afford 256 tokens left")).toBe(256)
  })

  it("returns null when the message has no affordability hint", () => {
    expect(parseAffordableTokens("rate limited, try again later")).toBeNull()
    expect(parseAffordableTokens("")).toBeNull()
  })

  it("returns null when the number is malformed", () => {
    expect(parseAffordableTokens("can only afford abc")).toBeNull()
  })
})

// ─── Stage 4 of server-hardening plan: classify402Terminal ───

describe("classify402Terminal — non-recoverable 402 detection", () => {
  it("matches 'insufficient credits' phrasing", () => {
    expect(classify402Terminal("OpenRouter error: Insufficient credits.")).toBe("insufficient_credits")
    expect(classify402Terminal("insufficient credits remaining")).toBe("insufficient_credits")
  })

  it("matches 'used all your credits' variant", () => {
    expect(classify402Terminal("You have used all your credits.")).toBe("insufficient_credits")
  })

  it("returns 'below_meaningful_threshold' when affordable < 4096", () => {
    const body = `can only afford 445 tokens`
    expect(classify402Terminal(body)).toBe("below_meaningful_threshold")
  })

  it("returns 'below_meaningful_threshold' for the user's repro (445)", () => {
    // From the actual user repro body: "...can only afford 445."
    const body = `{"error":{"message":"This request requires more credits, or fewer max_tokens. You requested up to 32768 tokens, but can only afford 445."}}`
    expect(classify402Terminal(body)).toBe("below_meaningful_threshold")
  })

  it("returns null when affordable is at the threshold (4096)", () => {
    expect(classify402Terminal(`can only afford ${MEANINGFUL_AFFORDABLE_THRESHOLD} tokens`)).toBeNull()
  })

  it("returns null when affordable is well above the threshold (legacy retry path)", () => {
    expect(classify402Terminal(`can only afford 15018 tokens`)).toBeNull()
  })

  it("returns null for an empty body", () => {
    expect(classify402Terminal("")).toBeNull()
  })

  it("returns null for non-string input (defensive)", () => {
    expect(classify402Terminal(null as unknown as string)).toBeNull()
    expect(classify402Terminal(undefined as unknown as string)).toBeNull()
  })

  it("'insufficient credits' wins over a high affordable count (belt-and-suspenders)", () => {
    // Both patterns in the same body — terminal still wins.
    const body = `Insufficient credits. (Internal: can only afford 9999)`
    expect(classify402Terminal(body)).toBe("insufficient_credits")
  })

  it("threshold constant is exported and reasonable (≥ 1024, ≤ 8192)", () => {
    expect(MEANINGFUL_AFFORDABLE_THRESHOLD).toBeGreaterThanOrEqual(1024)
    expect(MEANINGFUL_AFFORDABLE_THRESHOLD).toBeLessThanOrEqual(8192)
  })
})
