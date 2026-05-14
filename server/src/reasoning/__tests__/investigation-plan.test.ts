import { describe, it, expect } from "vitest"
import { reasoningEnvelopeSchema } from "../reasoning-schema.js"
import { repairReasoningResponse } from "../repair.js"
import { getInvestigationPlanBlock } from "../../providers/prompt/sections/reasoning-brief.js"

/**
 * Stage 3 of command-first-investigation plan: investigationPlan on the
 * implement + bug briefs. Pins schema, repair sanitization, and the
 * confidence-aware render block.
 */

function makeImplementEnvelope(overrides: { implementBrief?: Record<string, unknown> } & Record<string, unknown> = {}) {
  const { implementBrief: ibOverride, ...envOverrides } = overrides
  return {
    pipeline: "implement" as const,
    confidence: "HIGH" as const,
    decision: "proceed" as const,
    missingContext: [],
    reasoningTrace: "trace",
    reasoningChain: [],
    ...envOverrides,
    implementBrief: {
      intent: "build a thing",
      subcomponents: [],
      recommendedStack: { language: "ts", frameworks: [], libraries: [], rationale: "x" },
      architectureSketch: "x",
      buildPlan: [],
      edgeCases: [],
      consistencyNotes: [],
      investigationPlan: [],
      ...(ibOverride || {}),
    },
  }
}

describe("Stage 3 schema — investigationPlan accepts well-formed entries", () => {
  it("accepts entries with command + expectedSignal (pivotIf optional)", () => {
    const env = makeImplementEnvelope({
      implementBrief: {
        investigationPlan: [
          { command: "git status", expectedSignal: "clean", pivotIf: "if dirty, surface" },
          { command: "cat package.json", expectedSignal: "existing project" },
        ],
      },
    })
    const parsed = reasoningEnvelopeSchema.parse(env)
    expect(parsed.implementBrief!.investigationPlan).toHaveLength(2)
    expect(parsed.implementBrief!.investigationPlan[0].pivotIf).toBe("if dirty, surface")
    expect(parsed.implementBrief!.investigationPlan[1].pivotIf).toBeUndefined()
  })

  it("rejects more than 6 entries (cap)", () => {
    const env = makeImplementEnvelope({
      implementBrief: {
        investigationPlan: Array.from({ length: 7 }, (_, i) => ({
          command: `cmd${i}`,
          expectedSignal: `sig${i}`,
        })),
      },
    })
    expect(() => reasoningEnvelopeSchema.parse(env)).toThrow()
  })

  it("rejects entries with empty command (min(1))", () => {
    const env = makeImplementEnvelope({
      implementBrief: {
        investigationPlan: [{ command: "", expectedSignal: "x" }],
      },
    })
    expect(() => reasoningEnvelopeSchema.parse(env)).toThrow()
  })

  it("defaults to empty array on old briefs (pre-Stage-3 backward compat)", () => {
    const env = makeImplementEnvelope({
      implementBrief: {
        // no investigationPlan field at all
      },
    })
    // Need to remove investigationPlan from the default fixture to test this
    const raw = JSON.parse(JSON.stringify(env)) as Record<string, unknown>
    delete (raw.implementBrief as Record<string, unknown>).investigationPlan
    const parsed = reasoningEnvelopeSchema.parse(raw)
    expect(parsed.implementBrief!.investigationPlan).toEqual([])
  })
})

describe("Stage 3 repair — sanitizeInvestigationPlan", () => {
  it("filters entries with missing or empty command/expectedSignal", () => {
    const raw: Record<string, unknown> = {
      pipeline: "implement",
      confidence: "HIGH",
      decision: "proceed",
      missingContext: [],
      reasoningTrace: "",
      reasoningChain: [],
      implementBrief: {
        intent: "x",
        subcomponents: [],
        recommendedStack: { language: "ts", frameworks: [], libraries: [], rationale: "" },
        architectureSketch: "",
        buildPlan: [],
        edgeCases: [],
        consistencyNotes: [],
        investigationPlan: [
          { command: "ls", expectedSignal: "files visible" },     // OK
          { command: "", expectedSignal: "x" },                    // empty command — drop
          { command: "git status", expectedSignal: "" },           // empty signal — drop
          { command: "cat foo", expectedSignal: "ok", pivotIf: "" }, // empty pivotIf — keep, drop the field
          { not_an_entry: true } as unknown,                       // wrong shape — drop
        ],
      },
    }
    const repaired = repairReasoningResponse(raw) as Record<string, unknown>
    const plan = (repaired.implementBrief as Record<string, unknown>).investigationPlan as Array<Record<string, unknown>>
    expect(plan).toHaveLength(2)
    expect(plan[0]).toEqual({ command: "ls", expectedSignal: "files visible" })
    expect(plan[1].command).toBe("cat foo")
    expect(plan[1].pivotIf).toBeUndefined()
  })

  it("defaults missing investigationPlan to [] (graceful upgrade for old caches)", () => {
    const raw: Record<string, unknown> = {
      pipeline: "implement",
      confidence: "HIGH",
      decision: "proceed",
      missingContext: [],
      reasoningTrace: "",
      reasoningChain: [],
      implementBrief: {
        intent: "x",
        subcomponents: [],
        recommendedStack: { language: "ts", frameworks: [], libraries: [], rationale: "" },
        architectureSketch: "",
        buildPlan: [],
        edgeCases: [],
        consistencyNotes: [],
        // no investigationPlan field
      },
    }
    const repaired = repairReasoningResponse(raw) as Record<string, unknown>
    expect((repaired.implementBrief as Record<string, unknown>).investigationPlan).toEqual([])
  })

  it("caps at 6 entries (extra entries silently dropped)", () => {
    const raw: Record<string, unknown> = {
      pipeline: "implement",
      confidence: "HIGH",
      decision: "proceed",
      missingContext: [],
      reasoningTrace: "",
      reasoningChain: [],
      implementBrief: {
        intent: "x",
        subcomponents: [],
        recommendedStack: { language: "ts", frameworks: [], libraries: [], rationale: "" },
        architectureSketch: "",
        buildPlan: [],
        edgeCases: [],
        consistencyNotes: [],
        investigationPlan: Array.from({ length: 10 }, (_, i) => ({
          command: `cmd${i}`,
          expectedSignal: `sig${i}`,
        })),
      },
    }
    const repaired = repairReasoningResponse(raw) as Record<string, unknown>
    const plan = (repaired.implementBrief as Record<string, unknown>).investigationPlan as Array<unknown>
    expect(plan).toHaveLength(6)
  })
})

describe("Stage 3 render — getInvestigationPlanBlock confidence-aware framing", () => {
  const plan = [
    { command: "git status", expectedSignal: "clean working tree", pivotIf: "if dirty, surface" },
    { command: "cat package.json", expectedSignal: "existing React project" },
  ]

  it("returns null when the plan is empty", () => {
    expect(getInvestigationPlanBlock([], "HIGH")).toBeNull()
  })

  it("HIGH confidence emits RUN THESE directive", () => {
    const out = getInvestigationPlanBlock(plan, "HIGH")
    expect(out).not.toBeNull()
    expect(out!).toContain("RUN THESE")
    expect(out!).toContain("1. git status")
    expect(out!).toContain("expect: clean working tree")
    expect(out!).toContain("pivot:  if dirty, surface")
    expect(out!).toContain("2. cat package.json")
  })

  it("MEDIUM confidence softens the directive but still asks for them", () => {
    const out = getInvestigationPlanBlock(plan, "MEDIUM")
    expect(out).not.toBeNull()
    expect(out!).toContain("consider running")
    expect(out!).not.toContain("RUN THESE BEFORE")
  })

  it("LOW confidence frames as suggestions", () => {
    const out = getInvestigationPlanBlock(plan, "LOW")
    expect(out).not.toBeNull()
    expect(out!).toContain("suggested commands")
    expect(out!).toContain("reasoner confidence is LOW")
  })

  it("omits pivot line when pivotIf is absent", () => {
    const onlyExpect = [{ command: "ls", expectedSignal: "files visible" }]
    const out = getInvestigationPlanBlock(onlyExpect, "HIGH")
    expect(out!).toContain("expect: files visible")
    expect(out!).not.toContain("pivot:")
  })
})
