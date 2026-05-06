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
  // Phase 10: chunked-reasoning loop. Fires between every main-model turn —
  // chunk_plan picks the next chunk's files, chunk_reflect verifies the just-
  // executed chunk's coherence. Both are Gemini Flash, ~300-500 tok each.
  "chunk_plan",
  "chunk_reflect",
  // Phase 11: LLM second-opinion divergence check. Fires on heuristic flag
  // OR every 2nd chunk. Gated by `awareness.enabled` (default false in
  // Stages 1-3, true from Stage 4). ~300 tok.
  "divergence_check",
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

// ─── Chunk-plan pipeline brief (Phase 10) ───
//
// The planner runs at every chunk boundary. Input: preflight brief + chunks
// already done + last reflection. Output: which files the next chunk should
// touch, in what order, and why. The MAIN model is then told to honour this
// list — so the schema is deliberately tight.
export const chunkPlanBriefSchema = z.object({
  /** Short label for the chunk, shown in the CLI ("write models", "wire routes"). */
  nextAction: z.string().min(1).max(80),
  /** Concrete files to write/edit this chunk. ≤5 to keep main-model output small. */
  files: z.array(z.string().min(1).max(160)).min(1).max(5),
  /** One-line justification — the chunk loop displays this so the user sees the planner's logic. */
  rationale: z.string().min(1).max(240),
  /** Files this chunk depends on having been written/read in a prior chunk. */
  dependencies: z.array(z.string().max(160)).max(8),
  /** Coarse output-size hint for budgeting. */
  expectedSizeBin: z.enum(["tiny", "small", "medium", "large"]),
  /** True when the planner believes this is the final chunk. */
  isFinalChunk: z.boolean(),
})
export type ChunkPlanBrief = z.infer<typeof chunkPlanBriefSchema>

// ─── Chunk-reflector pipeline brief (Phase 10) ───
//
// The reflector runs after every chunk, on the just-executed tool results.
// Verifies the chunk is coherent (imports resolve, files non-empty, plan was
// honoured) and surfaces issues for the next planner call to address.
export const chunkReflectionBriefSchema = z.object({
  /** Did the chunk produce a coherent set of files? */
  coherent: z.boolean(),
  /** Surface any issues — empty list means the chunk landed clean. */
  issues: z.array(z.string().max(200)).max(6),
  /** Suggestion for what the next chunk should focus on (or "" if shouldStop). */
  nextFocus: z.string().max(240),
  /** Reflector says we're done — caller should emit completed instead of continuing. */
  shouldStop: z.boolean(),
})
export type ChunkReflectionBrief = z.infer<typeof chunkReflectionBriefSchema>

// ─── Divergence-verdict pipeline brief (Phase 11) ───
//
// The LLM half of the divergence detector. Reads the LITERAL original user
// prompt + files modified so far + last reflection, then judges whether the
// run is on track. Output is consumed by the confidence tracker:
//   - onTrack=false ⇒ one llm_off_track signal with detail = mismatches.
//   - score is FYI only; the tracker derives state from its own decay model
//     so two independent scoring schemes don't fight each other.
//   - suggestion is advisory; Stage 4's modal renders it as the default
//     action when the user is shown the off-course prompt.
export const divergenceVerdictBriefSchema = z.object({
  /** Single-bit verdict. False = at least one mismatches[] entry must explain why. */
  onTrack: z.boolean(),
  /** Reasoner's own 0-100 confidence the run is on track. Distinct from envelope confidence. */
  score: z.number().int().min(0).max(100),
  /** Concrete mismatches between the original ask and the work so far. ≤6, each ≤240 chars. */
  mismatches: z.array(z.string().max(240)).max(6),
  /** What the modal should default to when the user is asked. */
  suggestion: z.enum(["continue", "pause", "backtrack"]),
})
export type DivergenceVerdictBrief = z.infer<typeof divergenceVerdictBriefSchema>

// ─── Envelope: discriminated union over the four briefs ───
//
// Zod's discriminatedUnion would be cleaner but `pipeline` doesn't sit on
// every brief — it's only on the envelope. So we use a plain object with
// nullable brief fields and validate post-hoc that exactly one is filled.

export const reasoningEnvelopeSchema = z.object({
  pipeline: z.enum(["implement", "bug", "summary", "decision", "simple", "chunk_plan", "chunk_reflect", "divergence"]),
  confidence: confidenceSchema,
  decision: decisionSchema,
  missingContext: z.array(missingContextItemSchema).max(5).default([]),
  implementBrief: implementBriefSchema.nullable().optional(),
  bugBrief: bugBriefSchema.nullable().optional(),
  summaryBrief: summaryBriefSchema.nullable().optional(),
  decisionBrief: decisionBriefSchema.nullable().optional(),
  chunkPlanBrief: chunkPlanBriefSchema.nullable().optional(),
  chunkReflectionBrief: chunkReflectionBriefSchema.nullable().optional(),
  divergenceVerdictBrief: divergenceVerdictBriefSchema.nullable().optional(),
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
      case "implement":      return env.implementBrief
      case "bug":            return env.bugBrief
      case "summary":        return env.summaryBrief
      case "decision":       return env.decisionBrief
      case "chunk_plan":     return env.chunkPlanBrief
      case "chunk_reflect":  return env.chunkReflectionBrief
      case "divergence":     return env.divergenceVerdictBrief
      case "simple":         return null
    }
  })()
  if (env.pipeline !== "simple" && (slot === null || slot === undefined)) {
    throw new Error(`Reasoning envelope: pipeline='${env.pipeline}' but matching brief is null`)
  }
  return env
}
