/**
 * Reasoning schema — discriminated union over the four pipeline outputs.
 *
 * Every reasoning call (preflight / self_invoked / on_error / on_completion)
 * returns one of these shapes. The envelope carries pipeline routing,
 * confidence, the proceed-vs-ask decision, and a missingContext list.
 *
 * Zod is the source of truth; types are inferred from the schemas.
 */

import { z } from "zod"

export const triggerSchema = z.enum([
  "preflight",
  "self_invoked",
  "on_error",
  "on_completion",
])
export type ReasoningTrigger = z.infer<typeof triggerSchema>

export const confidenceSchema = z.enum(["HIGH", "MEDIUM", "LOW"])
export type Confidence = z.infer<typeof confidenceSchema>

export const decisionSchema = z.enum(["proceed", "ask_user"])
export type ReasoningDecision = z.infer<typeof decisionSchema>

const missingContextItemSchema = z.object({
  field: z.string().min(1).max(80),
  whyCritical: z.string().min(1).max(200),
  suggestedQuestion: z.string().min(1).max(300),
  exampleValue: z.string().max(120).optional(),
})
export type MissingContextItem = z.infer<typeof missingContextItemSchema>

// ─── Implement pipeline brief ───
export const implementBriefSchema = z.object({
  intent: z.string().min(1).max(300),
  subcomponents: z.array(z.object({
    name: z.string().min(1).max(80),
    kind: z.enum(["ui", "api", "db", "logic", "config", "infra"]),
  })).max(8),
  recommendedStack: z.object({
    language: z.string().min(1).max(40),
    frameworks: z.array(z.string().max(40)).max(5),
    libraries: z.array(z.string().max(60)).max(8),
    runtime: z.string().max(40).optional(),
    rationale: z.string().max(300),
  }),
  architectureSketch: z.string().max(400),
  buildPlan: z.array(z.object({
    step: z.string().min(1).max(120),
    deliverable: z.string().max(120),
    blockedBy: z.array(z.string().max(40)).max(4),
  })).max(8),
  edgeCases: z.array(z.string().max(160)).max(6),
  consistencyNotes: z.array(z.string().max(160)).max(4),
})
export type ImplementBrief = z.infer<typeof implementBriefSchema>

// ─── Bug pipeline brief ───
export const bugBriefSchema = z.object({
  symptom: z.string().min(1).max(300),
  expectedVsActual: z.object({
    expected: z.string().max(300),
    actual: z.string().max(300),
  }),
  suspectedBoundary: z.enum([
    "frontend", "backend", "db", "infra", "race_condition", "config", "deps", "unknown",
  ]),
  hypotheses: z.array(z.object({
    hypothesis: z.string().min(1).max(200),
    supportingEvidence: z.string().max(200),
    probability: confidenceSchema,
    invalidatingTest: z.string().max(200),
  })).max(5),
  rootCauseGuess: z.string().max(300).nullable(),
  proposedFix: z.object({
    description: z.string().min(1).max(400),
    scope: z.enum(["minimal", "moderate", "large"]),
    filesAffected: z.array(z.string().max(160)).max(8),
  }),
  sideEffects: z.array(z.string().max(160)).max(5),
  verificationSteps: z.array(z.string().max(200)).max(5),
})
export type BugBrief = z.infer<typeof bugBriefSchema>

// ─── Summary pipeline brief ───
export const summaryBriefSchema = z.object({
  audienceLevel: z.enum(["beginner", "dev", "mixed"]),
  keyFacts: z.array(z.string().max(200)).max(8),
  clusters: z.array(z.object({
    heading: z.string().min(1).max(80),
    points: z.array(z.string().max(200)).max(5),
  })).max(5),
  constraints: z.array(z.string().max(200)).max(4),
  whatMatters: z.array(z.string().max(200)).max(5),
  whatDoesnt: z.array(z.string().max(200)).max(3),
  hallucinationCheck: z.object({
    suspect: z.array(z.string().max(160)).max(4),
    verified: z.array(z.string().max(160)).max(6),
  }),
})
export type SummaryBrief = z.infer<typeof summaryBriefSchema>

// ─── Decision pipeline brief (self-invoked) ───
export const decisionBriefSchema = z.object({
  recommendation: z.string().min(1).max(200),
  alternatives: z.array(z.object({
    option: z.string().min(1).max(80),
    prosCons: z.string().max(240),
    fitScore: confidenceSchema,
  })).max(6),
  riskNotes: z.array(z.string().max(200)).max(4),
  proceedHint: z.string().max(200),
})
export type DecisionBrief = z.infer<typeof decisionBriefSchema>

// ─── Envelope: discriminated union over the four briefs ───
//
// Zod's discriminatedUnion would be cleaner but `pipeline` doesn't sit on
// every brief — it's only on the envelope. So we use a plain object with
// nullable brief fields and validate post-hoc that exactly one is filled.

export const reasoningEnvelopeSchema = z.object({
  pipeline: z.enum(["implement", "bug", "summary", "decision", "simple"]),
  confidence: confidenceSchema,
  decision: decisionSchema,
  missingContext: z.array(missingContextItemSchema).max(5).default([]),
  implementBrief: implementBriefSchema.nullable().optional(),
  bugBrief: bugBriefSchema.nullable().optional(),
  summaryBrief: summaryBriefSchema.nullable().optional(),
  decisionBrief: decisionBriefSchema.nullable().optional(),
  reasoningTrace: z.string().max(800),
})
export type ReasoningBrief = z.infer<typeof reasoningEnvelopeSchema>

/**
 * Post-parse invariant: the brief field corresponding to `pipeline` must be
 * populated; the others must be null/undefined. Returns the same envelope on
 * success, throws ZodError on violation so callers can treat it like any
 * other validation failure.
 */
export function assertEnvelopeShape(env: ReasoningBrief): ReasoningBrief {
  const slot = ((): unknown => {
    switch (env.pipeline) {
      case "implement": return env.implementBrief
      case "bug":       return env.bugBrief
      case "summary":   return env.summaryBrief
      case "decision":  return env.decisionBrief
      case "simple":    return null
    }
  })()
  if (env.pipeline !== "simple" && (slot === null || slot === undefined)) {
    throw new Error(`Reasoning envelope: pipeline='${env.pipeline}' but matching brief is null`)
  }
  return env
}
