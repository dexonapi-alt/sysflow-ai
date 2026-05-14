import { describe, it, expect } from "vitest"
import { repairReasoningResponse } from "../repair.js"
import { reasoningEnvelopeSchema } from "../reasoning-schema.js"

describe("repairReasoningResponse — pre-validation cleanup", () => {
  it("passes null/undefined/non-object inputs through unchanged", () => {
    expect(repairReasoningResponse(null)).toBeNull()
    expect(repairReasoningResponse(undefined)).toBeUndefined()
    expect(repairReasoningResponse("not an object")).toBe("not an object")
    expect(repairReasoningResponse(42)).toBe(42)
  })

  it("fills missing reasoningTrace with empty string", () => {
    const r = repairReasoningResponse({ pipeline: "simple", confidence: "HIGH", decision: "proceed" }) as Record<string, unknown>
    expect(r.reasoningTrace).toBe("")
  })

  it("fills missing missingContext with empty array", () => {
    const r = repairReasoningResponse({ pipeline: "simple", confidence: "HIGH", decision: "proceed" }) as Record<string, unknown>
    expect(r.missingContext).toEqual([])
  })

  it("repairs the exact production failure: implementBrief.recommendedStack.language === ''", () => {
    // This is the literal Zod error from the production log:
    //   path: ["implementBrief", "recommendedStack", "language"]
    //   message: "String must contain at least 1 character(s)"
    const malformed = {
      pipeline: "implement",
      confidence: "HIGH",
      decision: "proceed",
      missingContext: [],
      implementBrief: {
        intent: "build a thing",
        subcomponents: [],
        recommendedStack: {
          language: "",        // ← the offender
          frameworks: [],
          libraries: [],
          rationale: "",
        },
        architectureSketch: "",
        buildPlan: [],
        edgeCases: [],
        consistencyNotes: [],
      },
      reasoningTrace: "",
    }
    const repaired = repairReasoningResponse(malformed) as typeof malformed
    expect(repaired.implementBrief.recommendedStack.language).not.toBe("")
    expect(repaired.implementBrief.recommendedStack.language).toBe("(unspecified)")
    // And the whole envelope now passes Zod validation.
    expect(reasoningEnvelopeSchema.safeParse(repaired).success).toBe(true)
  })

  it("supplies a placeholder recommendedStack when implementBrief.recommendedStack is missing entirely", () => {
    const malformed = {
      pipeline: "implement",
      confidence: "MEDIUM",
      decision: "proceed",
      missingContext: [],
      implementBrief: {
        intent: "build a thing",
        subcomponents: [],
        // recommendedStack: undefined
        architectureSketch: "",
        buildPlan: [],
        edgeCases: [],
        consistencyNotes: [],
      },
      reasoningTrace: "",
    }
    const r = repairReasoningResponse(malformed) as Record<string, unknown>
    const ib = r.implementBrief as Record<string, unknown>
    expect(ib.recommendedStack).toBeDefined()
    expect(reasoningEnvelopeSchema.safeParse(r).success).toBe(true)
  })

  it("coerces null arrays to empty arrays inside recommendedStack", () => {
    const malformed = {
      pipeline: "implement",
      confidence: "HIGH",
      decision: "proceed",
      missingContext: [],
      implementBrief: {
        intent: "x",
        subcomponents: [],
        recommendedStack: {
          language: "TypeScript",
          frameworks: null,    // ← non-array
          libraries: null,     // ← non-array
          rationale: "",
        },
        architectureSketch: "",
        buildPlan: [],
        edgeCases: [],
        consistencyNotes: [],
      },
      reasoningTrace: "",
    }
    const repaired = repairReasoningResponse(malformed) as typeof malformed
    expect(Array.isArray(repaired.implementBrief.recommendedStack.frameworks)).toBe(true)
    expect(Array.isArray(repaired.implementBrief.recommendedStack.libraries)).toBe(true)
    expect(reasoningEnvelopeSchema.safeParse(repaired).success).toBe(true)
  })

  it("repairs an empty bugBrief envelope into a Zod-valid one", () => {
    const malformed = {
      pipeline: "bug",
      confidence: "MEDIUM",
      decision: "proceed",
      missingContext: [],
      bugBrief: {
        symptom: "",     // empty
        // expectedVsActual: missing
        suspectedBoundary: "", // empty — schema is enum, so we substitute "unknown"
        hypotheses: null,      // wrong type
        // rootCauseGuess: missing
        // proposedFix: missing
        sideEffects: null,
        verificationSteps: null,
      },
      reasoningTrace: "",
    }
    const repaired = repairReasoningResponse(malformed) as Record<string, unknown>
    const bb = repaired.bugBrief as Record<string, unknown>
    expect(bb.symptom).toBe("(unspecified)")
    expect(bb.suspectedBoundary).toBe("unknown")
    expect(bb.expectedVsActual).toEqual({ expected: "", actual: "" })
    expect(bb.rootCauseGuess).toBeNull()
    expect(bb.proposedFix).toBeDefined()
    expect(Array.isArray(bb.hypotheses)).toBe(true)
    expect(Array.isArray(bb.sideEffects)).toBe(true)
    expect(Array.isArray(bb.verificationSteps)).toBe(true)
    expect(reasoningEnvelopeSchema.safeParse(repaired).success).toBe(true)
  })

  it("repairs decisionBrief with missing recommendation + alternatives", () => {
    const malformed = {
      pipeline: "decision",
      confidence: "HIGH",
      decision: "proceed",
      missingContext: [],
      decisionBrief: { /* all empty */ },
      reasoningTrace: "",
    }
    const repaired = repairReasoningResponse(malformed) as Record<string, unknown>
    const db = repaired.decisionBrief as Record<string, unknown>
    expect(db.recommendation).toBe("(unspecified)")
    expect(db.proceedHint).toBe("")
    expect(db.alternatives).toEqual([])
    expect(db.riskNotes).toEqual([])
    expect(reasoningEnvelopeSchema.safeParse(repaired).success).toBe(true)
  })

  it("repairs chunkPlanBrief except the files-required invariant (genuinely malformed without files)", () => {
    const malformed = {
      pipeline: "chunk_plan",
      confidence: "HIGH",
      decision: "proceed",
      missingContext: [],
      chunkPlanBrief: {
        nextAction: "",        // → placeholder
        files: [],             // empty → schema requires min(1), still fails
        rationale: "",         // → placeholder
        // dependencies, expectedSizeBin, isFinalChunk all missing → defaults
      },
      reasoningTrace: "",
    }
    const repaired = repairReasoningResponse(malformed) as Record<string, unknown>
    const cp = repaired.chunkPlanBrief as Record<string, unknown>
    expect(cp.nextAction).toBe("(unspecified)")
    expect(cp.rationale).toBe("(unspecified)")
    expect(cp.expectedSizeBin).toBe("small")
    expect(cp.isFinalChunk).toBe(false)
    expect(Array.isArray(cp.dependencies)).toBe(true)
    // files still empty → schema correctly rejects (this is a genuinely
    // malformed plan, not a near-miss the repair should mask)
    expect(reasoningEnvelopeSchema.safeParse(repaired).success).toBe(false)
  })

  it("repairs chunkReflectionBrief with sensible defaults", () => {
    const malformed = {
      pipeline: "chunk_reflect",
      confidence: "HIGH",
      decision: "proceed",
      missingContext: [],
      chunkReflectionBrief: { /* empty */ },
      reasoningTrace: "",
    }
    const repaired = repairReasoningResponse(malformed) as Record<string, unknown>
    const cr = repaired.chunkReflectionBrief as Record<string, unknown>
    expect(cr.coherent).toBe(true)
    expect(cr.issues).toEqual([])
    expect(cr.nextFocus).toBe("")
    expect(cr.shouldStop).toBe(false)
    expect(reasoningEnvelopeSchema.safeParse(repaired).success).toBe(true)
  })

  it("repairs divergenceVerdictBrief with safe defaults (on-track on missing fields)", () => {
    const malformed = {
      pipeline: "divergence",
      confidence: "MEDIUM",
      decision: "proceed",
      missingContext: [],
      divergenceVerdictBrief: { /* empty */ },
      reasoningTrace: "",
    }
    const repaired = repairReasoningResponse(malformed) as Record<string, unknown>
    const dv = repaired.divergenceVerdictBrief as Record<string, unknown>
    expect(dv.onTrack).toBe(true)
    expect(dv.score).toBe(100)
    expect(dv.mismatches).toEqual([])
    expect(dv.suggestion).toBe("continue")
    expect(reasoningEnvelopeSchema.safeParse(repaired).success).toBe(true)
  })

  it("repairs Phase 16 implementElaborationBrief with empty whyThisApproach", () => {
    const malformed = {
      pipeline: "implement_elaborate",
      confidence: "HIGH",
      decision: "proceed",
      missingContext: [],
      implementElaborationBrief: {
        whyThisApproach: "",
        whyNotAlternative: null,
        preconditions: null,
        // confidence: missing
      },
      reasoningTrace: "",
    }
    const repaired = repairReasoningResponse(malformed) as Record<string, unknown>
    const eb = repaired.implementElaborationBrief as Record<string, unknown>
    expect(eb.whyThisApproach).toBe("(unspecified)")
    expect(eb.whyNotAlternative).toEqual([])
    expect(eb.preconditions).toEqual([])
    expect(eb.confidence).toBe("MEDIUM")
    expect(reasoningEnvelopeSchema.safeParse(repaired).success).toBe(true)
  })

  it("repairs summaryBrief with all-empty input", () => {
    const malformed = {
      pipeline: "summary",
      confidence: "HIGH",
      decision: "proceed",
      missingContext: [],
      summaryBrief: { /* empty */ },
      reasoningTrace: "",
    }
    const repaired = repairReasoningResponse(malformed) as Record<string, unknown>
    const sb = repaired.summaryBrief as Record<string, unknown>
    expect(sb.audienceLevel).toBe("dev")
    expect(sb.keyFacts).toEqual([])
    expect(sb.clusters).toEqual([])
    expect(sb.constraints).toEqual([])
    expect(sb.whatMatters).toEqual([])
    expect(sb.whatDoesnt).toEqual([])
    expect(sb.hallucinationCheck).toEqual({ suspect: [], verified: [] })
    expect(reasoningEnvelopeSchema.safeParse(repaired).success).toBe(true)
  })

  it("does not mutate fields that are already well-formed (round-trip preserves valid envelopes)", () => {
    const valid = {
      pipeline: "implement",
      confidence: "HIGH",
      decision: "proceed",
      missingContext: [],
      implementBrief: {
        intent: "build a postgres-backed user API",
        subcomponents: [{ name: "users-table", kind: "db" as const }],
        recommendedStack: {
          language: "TypeScript",
          frameworks: ["Fastify"],
          libraries: ["drizzle-orm", "zod"],
          rationale: "fast + typed",
        },
        architectureSketch: "Fastify app with drizzle migrations.",
        buildPlan: [
          { step: "scaffold", deliverable: "package.json + tsconfig", blockedBy: [] },
        ],
        edgeCases: ["empty-result handling"],
        consistencyNotes: ["use drizzle-kit for migrations"],
      },
      reasoningTrace: "implement plan",
      // Stage C: reasoningChain is now a recognised envelope field. A well-
      // formed envelope includes it explicitly; repair preserves it as-is.
      reasoningChain: ["the user wants a postgres-backed user API", "alternatives considered: prisma vs drizzle — picking drizzle for the ergonomics"],
    }
    const repaired = repairReasoningResponse(JSON.parse(JSON.stringify(valid))) as typeof valid
    expect(repaired).toEqual(valid)
    expect(reasoningEnvelopeSchema.safeParse(repaired).success).toBe(true)
  })
})
