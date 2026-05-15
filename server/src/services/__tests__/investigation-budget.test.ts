/**
 * Stage 5 of command-first-investigation plan: getInvestigationBudget
 * matrix tests.
 *
 * Pure function; no fetch, no env mutation. Each case verifies one
 * cell of the (model × intent × complexity) cap matrix.
 */

import { describe, it, expect } from "vitest"
import { getInvestigationBudget } from "../free-tier-policy.js"

describe("getInvestigationBudget", () => {
  describe("trivial tasks cap at 1 regardless of tier", () => {
    for (const model of ["claude-sonnet", "claude-opus", "gemini-flash", "openrouter-auto", "meta-llama/llama-3.1-405b"]) {
      it(`returns 1 for simple complexity on ${model}`, () => {
        expect(getInvestigationBudget({ model, intent: "implement", complexity: "simple" })).toBe(1)
        expect(getInvestigationBudget({ model, intent: "bug", complexity: "simple" })).toBe(1)
      })
    }
  })

  describe("free-tier non-trivial budgets", () => {
    it("returns 6 for free-tier bug-hunt (medium/complex)", () => {
      expect(getInvestigationBudget({ model: "openrouter-auto", intent: "bug", complexity: "medium" })).toBe(6)
      expect(getInvestigationBudget({ model: "openrouter-auto", intent: "bug", complexity: "complex" })).toBe(6)
      expect(getInvestigationBudget({ model: "meta-llama/llama-3.1-405b", intent: "bug", complexity: "medium" })).toBe(6)
    })

    it("returns 4 for free-tier implement (medium/complex)", () => {
      expect(getInvestigationBudget({ model: "openrouter-auto", intent: "implement", complexity: "medium" })).toBe(4)
      expect(getInvestigationBudget({ model: "openrouter-auto", intent: "implement", complexity: "complex" })).toBe(4)
    })

    it("returns 4 for free-tier unknown intent (treats as implement)", () => {
      expect(getInvestigationBudget({ model: "openrouter-auto", intent: "explain", complexity: "medium" })).toBe(4)
      expect(getInvestigationBudget({ model: "openrouter-auto", intent: "summary", complexity: "medium" })).toBe(4)
      expect(getInvestigationBudget({ model: "openrouter-auto", intent: null, complexity: "medium" })).toBe(4)
      expect(getInvestigationBudget({ model: "openrouter-auto", intent: undefined, complexity: "medium" })).toBe(4)
    })

    it("matches `bug` case-insensitively", () => {
      expect(getInvestigationBudget({ model: "openrouter-auto", intent: "BUG", complexity: "medium" })).toBe(6)
      expect(getInvestigationBudget({ model: "openrouter-auto", intent: "Bug", complexity: "complex" })).toBe(6)
    })
  })

  describe("paid-tier non-trivial budgets", () => {
    it("returns 10 across intents on paid models", () => {
      expect(getInvestigationBudget({ model: "claude-sonnet", intent: "implement", complexity: "medium" })).toBe(10)
      expect(getInvestigationBudget({ model: "claude-sonnet", intent: "bug", complexity: "complex" })).toBe(10)
      expect(getInvestigationBudget({ model: "claude-opus", intent: "explain", complexity: "medium" })).toBe(10)
      expect(getInvestigationBudget({ model: "gemini-pro", intent: "bug", complexity: "complex" })).toBe(10)
    })

    it("returns 10 for unknown/empty model (defaults to paid)", () => {
      expect(getInvestigationBudget({ model: "some-future-model", intent: "implement", complexity: "medium" })).toBe(10)
      expect(getInvestigationBudget({ model: null, intent: "implement", complexity: "complex" })).toBe(10)
      expect(getInvestigationBudget({ model: undefined, intent: "bug", complexity: "medium" })).toBe(10)
    })
  })

  describe("missing/null complexity", () => {
    it("treats missing complexity as non-trivial (uses tier+intent budget)", () => {
      // Null / undefined complexity → not simple → tier+intent budget applies.
      expect(getInvestigationBudget({ model: "openrouter-auto", intent: "implement", complexity: null })).toBe(4)
      expect(getInvestigationBudget({ model: "claude-sonnet", intent: "bug", complexity: undefined })).toBe(10)
    })
  })
})
