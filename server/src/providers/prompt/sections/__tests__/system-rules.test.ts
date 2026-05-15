/**
 * Phase 18 Stage 5: system-rules section gate-matrix tests.
 *
 * The section's `taskPlan` instruction is now conditional on
 * `runIntent` + `complexity` + the gating flag. These tests pin the
 * decision matrix at both the helper-function level
 * (`shouldIncludeTaskPlanInstruction`) and the rendered-string level
 * (`getSystemRulesSection`).
 */

import { describe, it, expect } from "vitest"
import { getSystemRulesSection, shouldIncludeTaskPlanInstruction } from "../system-rules.js"

describe("shouldIncludeTaskPlanInstruction — gate matrix", () => {
  describe("flag off (pre-Phase-18 behaviour)", () => {
    it("always returns true regardless of intent / complexity", () => {
      for (const intent of ["simple", "summary", "bug", "implement", null] as const) {
        for (const complexity of ["simple", "medium", "complex", null] as const) {
          expect(shouldIncludeTaskPlanInstruction({ runIntent: intent, complexity, gatingEnabled: false })).toBe(true)
        }
      }
    })
  })

  describe("pre-classification fallback", () => {
    it("returns true when runIntent is null (legacy / pre-classification window)", () => {
      expect(shouldIncludeTaskPlanInstruction({ runIntent: null, complexity: "medium" })).toBe(true)
      expect(shouldIncludeTaskPlanInstruction({ runIntent: undefined, complexity: "medium" })).toBe(true)
    })

    it("returns true when complexity is null", () => {
      expect(shouldIncludeTaskPlanInstruction({ runIntent: "implement", complexity: null })).toBe(true)
      expect(shouldIncludeTaskPlanInstruction({ runIntent: "implement", complexity: undefined })).toBe(true)
    })
  })

  describe("gate matches Phase 19 cli render gate", () => {
    it("implement + medium/complex → include taskPlan", () => {
      expect(shouldIncludeTaskPlanInstruction({ runIntent: "implement", complexity: "medium" })).toBe(true)
      expect(shouldIncludeTaskPlanInstruction({ runIntent: "implement", complexity: "complex" })).toBe(true)
    })

    it("implement + simple → omit taskPlan (trivial single-file fix)", () => {
      expect(shouldIncludeTaskPlanInstruction({ runIntent: "implement", complexity: "simple" })).toBe(false)
    })

    it("non-implement intents → omit taskPlan regardless of complexity", () => {
      for (const intent of ["simple", "summary", "bug"] as const) {
        for (const complexity of ["simple", "medium", "complex"] as const) {
          expect(shouldIncludeTaskPlanInstruction({ runIntent: intent, complexity })).toBe(false)
        }
      }
    })
  })
})

describe("getSystemRulesSection — rendered content", () => {
  it("renders the include-taskPlan rubric on implement + medium", () => {
    const out = getSystemRulesSection({ runIntent: "implement", complexity: "medium" })
    expect(out).toContain("FIRST RESPONSE (must include taskPlan)")
    expect(out).toContain('"taskPlan"')
    expect(out).not.toContain("NO taskPlan")
  })

  it("renders the no-taskPlan rubric on simple Q&A", () => {
    const out = getSystemRulesSection({ runIntent: "simple", complexity: "simple" })
    expect(out).toContain("NO taskPlan")
    expect(out).toContain("Do NOT include a `taskPlan` field")
    expect(out).not.toContain("must include taskPlan")
  })

  it("renders the no-taskPlan rubric on bug Q&A", () => {
    const out = getSystemRulesSection({ runIntent: "bug", complexity: "medium" })
    expect(out).toContain("NO taskPlan")
  })

  it("renders the no-taskPlan rubric on trivial implement (simple complexity)", () => {
    const out = getSystemRulesSection({ runIntent: "implement", complexity: "simple" })
    expect(out).toContain("NO taskPlan")
  })

  it("renders include-taskPlan when no gate args supplied (legacy callers)", () => {
    const out = getSystemRulesSection()
    expect(out).toContain("FIRST RESPONSE (must include taskPlan)")
  })

  it("renders include-taskPlan when gatingEnabled is false (off-switch)", () => {
    const out = getSystemRulesSection({ runIntent: "simple", complexity: "simple", gatingEnabled: false })
    expect(out).toContain("FIRST RESPONSE (must include taskPlan)")
  })

  it("both variants share the same subsequent-response / parallel / completed blocks", () => {
    const included = getSystemRulesSection({ runIntent: "implement", complexity: "complex" })
    const omitted = getSystemRulesSection({ runIntent: "simple", complexity: "simple" })
    for (const shared of [
      "SUBSEQUENT RESPONSES (single tool)",
      "PARALLEL TOOLS",
      "COMPLETED / FAILED / WAITING",
      "All file paths are relative to the PROJECT ROOT",
    ]) {
      expect(included).toContain(shared)
      expect(omitted).toContain(shared)
    }
  })
})
