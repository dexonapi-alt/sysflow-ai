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

  // ─── Phase 11 Stage 3: divergence-verdict envelope ───
  const baseDivergenceBrief = {
    onTrack: false as const,
    score: 35,
    mismatches: ["user asked for postgres but implementation imports mongoose"],
    suggestion: "backtrack" as const,
  }

  it("parses a valid divergence envelope", () => {
    const r = reasoningEnvelopeSchema.safeParse({
      pipeline: "divergence",
      confidence: "MEDIUM",
      decision: "proceed",
      missingContext: [],
      divergenceVerdictBrief: baseDivergenceBrief,
      reasoningTrace: "ok",
    })
    expect(r.success).toBe(true)
  })

  it("rejects divergence with score outside 0-100", () => {
    const r = reasoningEnvelopeSchema.safeParse({
      pipeline: "divergence",
      confidence: "HIGH",
      decision: "proceed",
      missingContext: [],
      divergenceVerdictBrief: { ...baseDivergenceBrief, score: 150 },
      reasoningTrace: "x",
    })
    expect(r.success).toBe(false)
  })

  it("rejects divergence with non-integer score", () => {
    const r = reasoningEnvelopeSchema.safeParse({
      pipeline: "divergence",
      confidence: "HIGH",
      decision: "proceed",
      missingContext: [],
      divergenceVerdictBrief: { ...baseDivergenceBrief, score: 42.5 },
      reasoningTrace: "x",
    })
    expect(r.success).toBe(false)
  })

  it("rejects divergence with bad suggestion enum", () => {
    const r = reasoningEnvelopeSchema.safeParse({
      pipeline: "divergence",
      confidence: "HIGH",
      decision: "proceed",
      missingContext: [],
      divergenceVerdictBrief: { ...baseDivergenceBrief, suggestion: "halt" },
      reasoningTrace: "x",
    })
    expect(r.success).toBe(false)
  })

  it("caps divergence mismatches at 6", () => {
    const r = reasoningEnvelopeSchema.safeParse({
      pipeline: "divergence",
      confidence: "HIGH",
      decision: "proceed",
      missingContext: [],
      divergenceVerdictBrief: {
        ...baseDivergenceBrief,
        mismatches: ["a", "b", "c", "d", "e", "f", "g"],
      },
      reasoningTrace: "x",
    })
    expect(r.success).toBe(false)
  })

  it("assertEnvelopeShape rejects divergence without divergenceVerdictBrief", () => {
    const env = reasoningEnvelopeSchema.parse({
      pipeline: "divergence",
      confidence: "HIGH",
      decision: "proceed",
      missingContext: [],
      reasoningTrace: "x",
    })
    expect(() => assertEnvelopeShape(env)).toThrow(/divergence.*null/)
  })

  it("assertEnvelopeShape passes divergence with brief", () => {
    const env = reasoningEnvelopeSchema.parse({
      pipeline: "divergence",
      confidence: "HIGH",
      decision: "proceed",
      missingContext: [],
      divergenceVerdictBrief: baseDivergenceBrief,
      reasoningTrace: "x",
    })
    expect(() => assertEnvelopeShape(env)).not.toThrow()
  })

  // ─── Phase 16 Stage 2: implement_elaborate pipeline ───

  it("parses a valid implement_elaborate envelope", () => {
    const r = reasoningEnvelopeSchema.safeParse({
      pipeline: "implement_elaborate",
      confidence: "MEDIUM",
      decision: "proceed",
      missingContext: [],
      implementElaborationBrief: {
        whyThisApproach: "TypeScript + Fastify gives us type safety with low runtime overhead.",
        whyNotAlternative: ["Express adds middleware overhead we don't need", "Nest requires decorators we'd have to teach the team"],
        preconditions: ["cwd is a git repo", "package.json exists"],
        confidence: "HIGH",
      },
      reasoningTrace: "elaboration thinking",
    })
    expect(r.success).toBe(true)
  })

  it("rejects implementElaborationBrief with empty whyThisApproach", () => {
    const r = reasoningEnvelopeSchema.safeParse({
      pipeline: "implement_elaborate",
      confidence: "MEDIUM",
      decision: "proceed",
      missingContext: [],
      implementElaborationBrief: {
        whyThisApproach: "", // min(1) violation
        whyNotAlternative: [],
        preconditions: [],
        confidence: "HIGH",
      },
      reasoningTrace: "x",
    })
    expect(r.success).toBe(false)
  })

  it("rejects implementElaborationBrief with too many alternatives (>4)", () => {
    const r = reasoningEnvelopeSchema.safeParse({
      pipeline: "implement_elaborate",
      confidence: "MEDIUM",
      decision: "proceed",
      missingContext: [],
      implementElaborationBrief: {
        whyThisApproach: "x",
        whyNotAlternative: ["a", "b", "c", "d", "e"], // max(4) violation
        preconditions: [],
        confidence: "HIGH",
      },
      reasoningTrace: "x",
    })
    expect(r.success).toBe(false)
  })

  it("assertEnvelopeShape rejects implement_elaborate without the elaboration brief", () => {
    const env = reasoningEnvelopeSchema.parse({
      pipeline: "implement_elaborate",
      confidence: "HIGH",
      decision: "proceed",
      missingContext: [],
      reasoningTrace: "x",
    })
    expect(() => assertEnvelopeShape(env)).toThrow(/implement_elaborate.*null/)
  })

  it("assertEnvelopeShape passes implement_elaborate with brief", () => {
    const env = reasoningEnvelopeSchema.parse({
      pipeline: "implement_elaborate",
      confidence: "HIGH",
      decision: "proceed",
      missingContext: [],
      implementElaborationBrief: {
        whyThisApproach: "x",
        whyNotAlternative: [],
        preconditions: [],
        confidence: "HIGH",
      },
      reasoningTrace: "x",
    })
    expect(() => assertEnvelopeShape(env)).not.toThrow()
  })

  // ─── Phase 16 Stage 3: implement_elaborate trigger + pipeline routing ───

  it("triggerSchema accepts implement_elaborate", async () => {
    const { triggerSchema } = await import("../reasoning-schema.js")
    expect(triggerSchema.safeParse("implement_elaborate").success).toBe(true)
  })

  it("getPipelineSystemPrompt returns the elaborate prompt for the implement_elaborate kind", async () => {
    const { getPipelineSystemPrompt } = await import("../pipelines/index.js")
    const prompt = getPipelineSystemPrompt("implement_elaborate")
    expect(prompt).toContain("IMPLEMENT-ELABORATE")
    expect(prompt).toContain("whyThisApproach")
    expect(prompt).toContain("preconditions")
  })
})
