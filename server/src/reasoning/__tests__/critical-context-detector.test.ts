import { describe, it, expect } from "vitest"
import { applyCriticalContextDetector } from "../critical-context-detector.js"
import type { ReasoningBrief } from "../reasoning-schema.js"

const briefWith = (
  decision: "proceed" | "ask_user",
  missing: Array<{ field: string; whyCritical?: string; suggestedQuestion?: string }>,
): ReasoningBrief => ({
  pipeline: "implement",
  confidence: "MEDIUM",
  decision,
  missingContext: missing.map((m) => ({
    field: m.field,
    whyCritical: m.whyCritical ?? "x",
    suggestedQuestion: m.suggestedQuestion ?? "q",
  })),
  reasoningTrace: "test",
})

describe("applyCriticalContextDetector", () => {
  it("prunes items whose tokens already appear in user message", () => {
    const brief = briefWith("ask_user", [{ field: "google_sheet_id" }])
    const out = applyCriticalContextDetector(brief, "the sheet 1AbCdE is here")
    expect(out.missingContext.length).toBe(0)
    expect(out.decision).toBe("proceed")
  })

  it("keeps items that are NOT in the user message", () => {
    const brief = briefWith("ask_user", [{ field: "service_account_json" }])
    const out = applyCriticalContextDetector(brief, "create a sheet automation")
    expect(out.missingContext.length).toBe(1)
    expect(out.decision).toBe("ask_user")
  })

  it("'just guess' forces proceed even with missing items", () => {
    const brief = briefWith("ask_user", [{ field: "service_account_json" }])
    const out = applyCriticalContextDetector(brief, "just guess for the credentials")
    expect(out.decision).toBe("proceed")
  })

  it("'use whatever' forces proceed", () => {
    const brief = briefWith("ask_user", [{ field: "framework" }])
    const out = applyCriticalContextDetector(brief, "use whatever framework you want")
    expect(out.decision).toBe("proceed")
  })

  it("'you decide' forces proceed", () => {
    const brief = briefWith("ask_user", [{ field: "orm" }])
    const out = applyCriticalContextDetector(brief, "you decide which orm")
    expect(out.decision).toBe("proceed")
  })

  it("flips decision to ask_user if proceed but missing items remain", () => {
    const brief = briefWith("proceed", [{ field: "subscription_plan_price_id" }])
    // Use a userMessage that doesn't contain ANY token from the field name
    // so the prune step can't satisfy it.
    const out = applyCriticalContextDetector(brief, "build a checkout integration")
    // Reasoner said proceed but didn't address subscription_plan_price_id; we force ask.
    expect(out.decision).toBe("ask_user")
    expect(out.missingContext.length).toBe(1)
  })

  it("keeps proceed when there are no missing items", () => {
    const brief = briefWith("proceed", [])
    const out = applyCriticalContextDetector(brief, "any prompt")
    expect(out.decision).toBe("proceed")
    expect(out.missingContext.length).toBe(0)
  })

  it("multi-token field name pruning works", () => {
    const brief = briefWith("ask_user", [{ field: "discord_bot_token" }])
    const out = applyCriticalContextDetector(brief, "the discord_bot_token is XYZ123")
    expect(out.missingContext.length).toBe(0)
  })

  it("short field names (< 4 chars per token) fall back to substring match", () => {
    const brief = briefWith("ask_user", [{ field: "id" }])
    // "id" alone won't trigger token-based prune; falls back to substring check
    const out1 = applyCriticalContextDetector(brief, "set id to 5")
    expect(out1.missingContext.length).toBe(0)
    const out2 = applyCriticalContextDetector(brief, "do something")
    expect(out2.missingContext.length).toBe(1)
  })
})
