import { describe, it, expect } from "vitest"
import { reasoningEnvelopeSchema, assertEnvelopeShape } from "../reasoning-schema.js"

const baseImplementBrief = {
  intent: "build x",
  subcomponents: [{ name: "a", kind: "logic" as const }],
  recommendedStack: { language: "Python", frameworks: [], libraries: [], rationale: "fits" },
  architectureSketch: "single script",
  buildPlan: [{ step: "scaffold", deliverable: "main.py", blockedBy: [] }],
  edgeCases: [],
  consistencyNotes: [],
}

describe("reasoning-schema", () => {
  it("parses a valid implement envelope", () => {
    const r = reasoningEnvelopeSchema.safeParse({
      pipeline: "implement",
      confidence: "HIGH",
      decision: "proceed",
      missingContext: [],
      implementBrief: baseImplementBrief,
      reasoningTrace: "ok",
    })
    expect(r.success).toBe(true)
  })

  it("rejects missing required fields", () => {
    const r = reasoningEnvelopeSchema.safeParse({ pipeline: "implement" })
    expect(r.success).toBe(false)
  })

  it("rejects oversized reasoningTrace", () => {
    const r = reasoningEnvelopeSchema.safeParse({
      pipeline: "simple",
      confidence: "HIGH",
      decision: "proceed",
      missingContext: [],
      reasoningTrace: "x".repeat(1000),
    })
    expect(r.success).toBe(false)
  })

  it("constrains decision and confidence enums", () => {
    const r = reasoningEnvelopeSchema.safeParse({
      pipeline: "implement",
      confidence: "MAYBE",
      decision: "proceed",
      missingContext: [],
      reasoningTrace: "x",
    })
    expect(r.success).toBe(false)
  })

  it("caps missingContext at 5 entries", () => {
    const tooMany = Array.from({ length: 6 }, (_, i) => ({
      field: `f${i}`,
      whyCritical: "x",
      suggestedQuestion: "q",
    }))
    const r = reasoningEnvelopeSchema.safeParse({
      pipeline: "implement",
      confidence: "HIGH",
      decision: "ask_user",
      missingContext: tooMany,
      implementBrief: baseImplementBrief,
      reasoningTrace: "x",
    })
    expect(r.success).toBe(false)
  })

  it("assertEnvelopeShape rejects pipeline mismatch", () => {
    const env = reasoningEnvelopeSchema.parse({
      pipeline: "implement",
      confidence: "HIGH",
      decision: "proceed",
      missingContext: [],
      reasoningTrace: "x",
      // implementBrief missing!
    })
    expect(() => assertEnvelopeShape(env)).toThrow(/implement.*null/)
  })

  it("assertEnvelopeShape allows pipeline=simple with no brief", () => {
    const env = reasoningEnvelopeSchema.parse({
      pipeline: "simple",
      confidence: "HIGH",
      decision: "proceed",
      missingContext: [],
      reasoningTrace: "x",
    })
    expect(() => assertEnvelopeShape(env)).not.toThrow()
  })

  it("parses a bug envelope with hypotheses", () => {
    const r = reasoningEnvelopeSchema.safeParse({
      pipeline: "bug",
      confidence: "MEDIUM",
      decision: "proceed",
      missingContext: [],
      bugBrief: {
        symptom: "API 500",
        expectedVsActual: { expected: "200", actual: "500" },
        suspectedBoundary: "config",
        hypotheses: [{ hypothesis: "missing env", supportingEvidence: "TypeError on undefined", probability: "HIGH", invalidatingTest: "check env" }],
        rootCauseGuess: null,
        proposedFix: { description: "add env var", scope: "minimal", filesAffected: [] },
        sideEffects: [],
        verificationSteps: ["redeploy"],
      },
      reasoningTrace: "post-deploy 500",
    })
    expect(r.success).toBe(true)
  })

  it("parses a decision envelope", () => {
    const r = reasoningEnvelopeSchema.safeParse({
      pipeline: "decision",
      confidence: "HIGH",
      decision: "proceed",
      missingContext: [],
      decisionBrief: {
        recommendation: "Drizzle",
        alternatives: [{ option: "Drizzle", prosCons: "small", fitScore: "HIGH" }],
        riskNotes: [],
        proceedHint: "install drizzle-orm",
      },
      reasoningTrace: "ORM choice",
    })
    expect(r.success).toBe(true)
  })

  it("rejects unknown pipeline", () => {
    const r = reasoningEnvelopeSchema.safeParse({
      pipeline: "novel",
      confidence: "HIGH",
      decision: "proceed",
      missingContext: [],
      reasoningTrace: "x",
    })
    expect(r.success).toBe(false)
  })

  // ─── Phase 10: chunk_plan + chunk_reflect envelopes ───

  const baseChunkPlanBrief = {
    nextAction: "write user model",
    files: ["src/models/User.js"],
    rationale: "models come before routes that import them",
    dependencies: ["src/db.js"],
    expectedSizeBin: "small" as const,
    isFinalChunk: false,
  }

  const baseChunkReflectionBrief = {
    coherent: true,
    issues: [],
    nextFocus: "wire user routes into server.js",
    shouldStop: false,
  }

  it("parses a valid chunk_plan envelope", () => {
    const r = reasoningEnvelopeSchema.safeParse({
      pipeline: "chunk_plan",
      confidence: "HIGH",
      decision: "proceed",
      missingContext: [],
      chunkPlanBrief: baseChunkPlanBrief,
      reasoningTrace: "models first",
    })
    expect(r.success).toBe(true)
  })

  it("parses a valid chunk_reflect envelope", () => {
    const r = reasoningEnvelopeSchema.safeParse({
      pipeline: "chunk_reflect",
      confidence: "HIGH",
      decision: "proceed",
      missingContext: [],
      chunkReflectionBrief: baseChunkReflectionBrief,
      reasoningTrace: "all good",
    })
    expect(r.success).toBe(true)
  })

  it("chunk_plan rejects more than 5 files", () => {
    const r = reasoningEnvelopeSchema.safeParse({
      pipeline: "chunk_plan",
      confidence: "HIGH",
      decision: "proceed",
      missingContext: [],
      chunkPlanBrief: { ...baseChunkPlanBrief, files: ["a", "b", "c", "d", "e", "f"] },
      reasoningTrace: "x",
    })
    expect(r.success).toBe(false)
  })

  it("chunk_plan requires at least 1 file", () => {
    const r = reasoningEnvelopeSchema.safeParse({
      pipeline: "chunk_plan",
      confidence: "HIGH",
      decision: "proceed",
      missingContext: [],
      chunkPlanBrief: { ...baseChunkPlanBrief, files: [] },
      reasoningTrace: "x",
    })
    expect(r.success).toBe(false)
  })

  it("chunk_plan rejects unknown expectedSizeBin", () => {
    const r = reasoningEnvelopeSchema.safeParse({
      pipeline: "chunk_plan",
      confidence: "HIGH",
      decision: "proceed",
      missingContext: [],
      chunkPlanBrief: { ...baseChunkPlanBrief, expectedSizeBin: "huge" },
      reasoningTrace: "x",
    })
    expect(r.success).toBe(false)
  })

  it("chunk_reflect caps issues at 6", () => {
    const r = reasoningEnvelopeSchema.safeParse({
      pipeline: "chunk_reflect",
      confidence: "HIGH",
      decision: "proceed",
      missingContext: [],
      chunkReflectionBrief: { ...baseChunkReflectionBrief, issues: ["a", "b", "c", "d", "e", "f", "g"] },
      reasoningTrace: "x",
    })
    expect(r.success).toBe(false)
  })

  it("assertEnvelopeShape rejects chunk_plan without chunkPlanBrief", () => {
    const env = reasoningEnvelopeSchema.parse({
      pipeline: "chunk_plan",
      confidence: "HIGH",
      decision: "proceed",
      missingContext: [],
      reasoningTrace: "x",
      // chunkPlanBrief missing!
    })
    expect(() => assertEnvelopeShape(env)).toThrow(/chunk_plan.*null/)
  })

  it("assertEnvelopeShape rejects chunk_reflect without chunkReflectionBrief", () => {
    const env = reasoningEnvelopeSchema.parse({
      pipeline: "chunk_reflect",
      confidence: "HIGH",
      decision: "proceed",
      missingContext: [],
      reasoningTrace: "x",
    })
    expect(() => assertEnvelopeShape(env)).toThrow(/chunk_reflect.*null/)
  })

  it("assertEnvelopeShape passes chunk_plan with brief", () => {
    const env = reasoningEnvelopeSchema.parse({
      pipeline: "chunk_plan",
      confidence: "MEDIUM",
      decision: "proceed",
      missingContext: [],
      chunkPlanBrief: baseChunkPlanBrief,
      reasoningTrace: "x",
    })
    expect(() => assertEnvelopeShape(env)).not.toThrow()
  })
})
