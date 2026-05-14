import { describe, it, expect } from "vitest"
import { shouldRunIterativeChain } from "../free-tier-policy.js"

/**
 * Iterative paragraph chain gate matrix.
 *
 * User feedback that drove the gate: *"reason it one by one → call llm
 * → reason 2nd → reason 3rd time → repeat until done"*. The gate
 * decides when the N+1 Flash-call cost is worth paying.
 */

describe("shouldRunIterativeChain — pipeline + complexity matrix", () => {
  const base = {
    model: "gemini-flash" as string | null,
    flagEnabled: true,
    complexity: "medium" as "simple" | "medium" | "complex" | null,
  }

  it("returns false when the flag is off (cost-constrained users)", () => {
    expect(shouldRunIterativeChain({ ...base, kind: "implement", flagEnabled: false })).toBe(false)
  })

  it("fires on the deep-reasoning pipelines (implement / bug / decision)", () => {
    expect(shouldRunIterativeChain({ ...base, kind: "implement" })).toBe(true)
    expect(shouldRunIterativeChain({ ...base, kind: "bug" })).toBe(true)
    expect(shouldRunIterativeChain({ ...base, kind: "decision" })).toBe(true)
  })

  it("skips summary (user-facing prose — paragraph iteration doesn't add value)", () => {
    expect(shouldRunIterativeChain({ ...base, kind: "summary" })).toBe(false)
  })

  it("skips implement_elaborate (it IS already a follow-on pass)", () => {
    expect(shouldRunIterativeChain({ ...base, kind: "implement_elaborate" })).toBe(false)
  })

  it("skips divergence (Phase 16 has its own second-look gate)", () => {
    expect(shouldRunIterativeChain({ ...base, kind: "divergence" })).toBe(false)
  })

  it("skips chunk_plan and chunk_reflect (per-chunk N+1 calls = runaway cost)", () => {
    expect(shouldRunIterativeChain({ ...base, kind: "chunk_plan" })).toBe(false)
    expect(shouldRunIterativeChain({ ...base, kind: "chunk_reflect" })).toBe(false)
  })

  it("skips when complexity is simple (anti-overthinking guard)", () => {
    expect(shouldRunIterativeChain({ ...base, kind: "implement", complexity: "simple" })).toBe(false)
  })

  it("fires on medium and complex complexity for the deep pipelines", () => {
    expect(shouldRunIterativeChain({ ...base, kind: "implement", complexity: "medium" })).toBe(true)
    expect(shouldRunIterativeChain({ ...base, kind: "implement", complexity: "complex" })).toBe(true)
    expect(shouldRunIterativeChain({ ...base, kind: "bug", complexity: "complex" })).toBe(true)
  })

  it("reasoner-backend-agnostic — model identity does not affect the gate", () => {
    for (const model of ["gemini-flash", "claude-sonnet", "claude-opus", "openrouter-auto", null]) {
      expect(shouldRunIterativeChain({ ...base, kind: "implement", model })).toBe(true)
    }
  })

  it("null/undefined complexity defaults to fire (additive safety — don't accidentally skip)", () => {
    expect(shouldRunIterativeChain({ ...base, kind: "implement", complexity: null })).toBe(true)
    expect(shouldRunIterativeChain({ ...base, kind: "implement", complexity: undefined })).toBe(true)
  })
})
