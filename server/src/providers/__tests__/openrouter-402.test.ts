import { describe, it, expect } from "vitest"
import { parseAffordableTokens } from "../openrouter.js"

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
