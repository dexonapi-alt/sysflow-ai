import { describe, it, expect } from "vitest"
import { getReasoningBriefSection } from "../reasoning-brief.js"
import type { ReasoningBrief } from "../../../../reasoning/reasoning-schema.js"

const baseImplementBrief: ReasoningBrief = {
  pipeline: "implement",
  confidence: "MEDIUM",
  decision: "proceed",
  missingContext: [],
  implementBrief: {
    intent: "build a postgres-backed user API",
    subcomponents: [],
    recommendedStack: { language: "TypeScript", frameworks: ["Fastify"], libraries: ["drizzle-orm"], rationale: "fast + typed" },
    architectureSketch: "single Fastify server with Drizzle migrations.",
    buildPlan: [],
    edgeCases: [],
    consistencyNotes: [],
    investigationPlan: [],
  },
  reasoningTrace: "ok",
  reasoningChain: [],
}

const baseElaborationBrief: ReasoningBrief = {
  pipeline: "implement_elaborate",
  confidence: "HIGH",
  decision: "proceed",
  missingContext: [],
  implementElaborationBrief: {
    whyThisApproach: "Drizzle's typed schema gives the user's request for 'strict typing' a working foundation.",
    whyNotAlternative: [
      "Express adds middleware overhead we don't need at this scale",
      "Mongoose conflicts with the user's explicit Postgres ask",
    ],
    preconditions: ["package.json must exist", "DATABASE_URL env var assumed"],
    confidence: "HIGH",
  },
  reasoningTrace: "elaboration",
  reasoningChain: [],
}

describe("getReasoningBriefSection — implement brief", () => {
  it("renders the implement section with stack + architecture + build plan", () => {
    const out = getReasoningBriefSection({ reasoningBrief: baseImplementBrief })
    expect(out).not.toBeNull()
    expect(out).toContain("REASONING BRIEF")
    expect(out).toContain("INTENT: build a postgres-backed user API")
    expect(out).toContain("STACK: TypeScript + Fastify + drizzle-orm")
    expect(out).toContain("ARCHITECTURE: single Fastify server")
  })

  it("returns null on simple pipeline (no overhead in the prompt)", () => {
    expect(
      getReasoningBriefSection({
        reasoningBrief: { ...baseImplementBrief, pipeline: "simple", implementBrief: undefined },
      }),
    ).toBeNull()
  })

  it("returns null when no brief is present", () => {
    expect(getReasoningBriefSection({})).toBeNull()
  })
})

// ─── Phase 16 Stage 3: chained-elaboration sub-block ───

describe("getReasoningBriefSection — DEEPER REASONING sub-block", () => {
  it("renders the elaboration sub-block under the implement brief when both are present", () => {
    const out = getReasoningBriefSection({
      reasoningBrief: baseImplementBrief,
      reasoningElaborationBrief: baseElaborationBrief,
    })
    expect(out).not.toBeNull()
    expect(out).toContain("DEEPER REASONING")
    expect(out).toContain("re-scored confidence: HIGH")
    expect(out).toContain("WHY THIS APPROACH:")
    expect(out).toContain("Drizzle's typed schema")
    expect(out).toContain("ALTERNATIVES REJECTED:")
    expect(out).toContain("Express adds middleware overhead")
    expect(out).toContain("PRECONDITIONS")
    expect(out).toContain("DATABASE_URL")
  })

  it("does NOT render the elaboration sub-block when no elaboration brief is present", () => {
    const out = getReasoningBriefSection({ reasoningBrief: baseImplementBrief })
    expect(out).not.toBeNull()
    expect(out).not.toContain("DEEPER REASONING")
  })

  it("does NOT render the elaboration sub-block when the primary brief is not implement", () => {
    // bug brief paired with an elaboration shouldn't trigger the sub-block.
    const bugBrief: ReasoningBrief = {
      pipeline: "bug",
      confidence: "MEDIUM",
      decision: "proceed",
      missingContext: [],
      bugBrief: {
        symptom: "500",
        expectedVsActual: { expected: "200", actual: "500" },
        suspectedBoundary: "config",
        hypotheses: [],
        rootCauseGuess: null,
        proposedFix: { description: "fix", scope: "minimal", filesAffected: [] },
        sideEffects: [],
        verificationSteps: [],
        investigationPlan: [],
      },
      reasoningTrace: "x",
      reasoningChain: [],
    }
    const out = getReasoningBriefSection({
      reasoningBrief: bugBrief,
      reasoningElaborationBrief: baseElaborationBrief,
    })
    expect(out).not.toBeNull()
    expect(out).not.toContain("DEEPER REASONING")
  })

  it("renders only the populated elaboration sub-arrays (skips empty alternatives / preconditions)", () => {
    const minimalElab: ReasoningBrief = {
      ...baseElaborationBrief,
      implementElaborationBrief: {
        whyThisApproach: "the only viable option given the user's constraint",
        whyNotAlternative: [], // empty
        preconditions: [],     // empty
        confidence: "HIGH",
      },
    }
    const out = getReasoningBriefSection({
      reasoningBrief: baseImplementBrief,
      reasoningElaborationBrief: minimalElab,
    })
    expect(out).toContain("DEEPER REASONING")
    expect(out).toContain("WHY THIS APPROACH:")
    expect(out).not.toContain("ALTERNATIVES REJECTED")
    expect(out).not.toContain("PRECONDITIONS")
  })

  it("renders the elaboration's downgraded confidence so the model treats the brief as tentative", () => {
    const downgraded: ReasoningBrief = {
      ...baseElaborationBrief,
      implementElaborationBrief: {
        whyThisApproach: "second-look caught a problem",
        whyNotAlternative: ["Postgres was specified but the implementation went Mongo"],
        preconditions: [],
        confidence: "LOW",
      },
    }
    const out = getReasoningBriefSection({
      reasoningBrief: baseImplementBrief,
      reasoningElaborationBrief: downgraded,
    })
    expect(out).toContain("re-scored confidence: LOW")
  })
})
