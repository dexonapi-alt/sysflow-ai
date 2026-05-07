/**
 * Pre-validation repair for reasoning responses.
 *
 * Gemini Flash is the cheapest reliable JSON producer we have, and it gets
 * the envelope shape right > 95% of the time — but the remaining 5% are
 * "almost valid" responses where a single field violates a `min(1)` or
 * shows up as `null` instead of `[]`. Without repair, the whole brief is
 * dropped and the agent loses the value of the reasoning call.
 *
 * Repair strategy: small, conservative coercions that preserve the
 * envelope's intent. We DON'T fabricate data — empty / missing fields
 * are filled with explicit placeholder strings ("(unspecified)") so the
 * downstream prompt sections render obviously-empty text rather than
 * crashing on validation. The schema stays strict for fields where
 * empty content would be misleading (concrete file paths, etc.).
 *
 * Pure, exported, testable. Mutation-style for clarity (the input has
 * already been `JSON.parse`d into a fresh tree, so mutating in place
 * is safe).
 */

const PLACEHOLDER = "(unspecified)"

/**
 * Apply repairs to a reasoning-envelope-shaped object. Returns the
 * (possibly-mutated) input. Safe to call on null/undefined/non-object
 * inputs — they pass through unchanged so the caller's parse errors
 * still surface for genuinely malformed responses.
 */
export function repairReasoningResponse(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw
  const obj = raw as Record<string, unknown>

  // ─── Envelope-level repairs ───
  if (typeof obj.reasoningTrace !== "string") {
    obj.reasoningTrace = ""
  }
  if (!Array.isArray(obj.missingContext)) {
    obj.missingContext = []
  }

  // ─── implementBrief ───
  if (obj.implementBrief && typeof obj.implementBrief === "object") {
    repairImplementBrief(obj.implementBrief as Record<string, unknown>)
  }

  // ─── bugBrief ───
  if (obj.bugBrief && typeof obj.bugBrief === "object") {
    repairBugBrief(obj.bugBrief as Record<string, unknown>)
  }

  // ─── decisionBrief ───
  if (obj.decisionBrief && typeof obj.decisionBrief === "object") {
    repairDecisionBrief(obj.decisionBrief as Record<string, unknown>)
  }

  // ─── chunkPlanBrief ───
  if (obj.chunkPlanBrief && typeof obj.chunkPlanBrief === "object") {
    repairChunkPlanBrief(obj.chunkPlanBrief as Record<string, unknown>)
  }

  // ─── chunkReflectionBrief ───
  if (obj.chunkReflectionBrief && typeof obj.chunkReflectionBrief === "object") {
    repairChunkReflectionBrief(obj.chunkReflectionBrief as Record<string, unknown>)
  }

  // ─── divergenceVerdictBrief ───
  if (obj.divergenceVerdictBrief && typeof obj.divergenceVerdictBrief === "object") {
    repairDivergenceVerdictBrief(obj.divergenceVerdictBrief as Record<string, unknown>)
  }

  // ─── implementElaborationBrief (Phase 16) ───
  if (obj.implementElaborationBrief && typeof obj.implementElaborationBrief === "object") {
    repairElaborationBrief(obj.implementElaborationBrief as Record<string, unknown>)
  }

  // ─── summaryBrief ───
  if (obj.summaryBrief && typeof obj.summaryBrief === "object") {
    repairSummaryBrief(obj.summaryBrief as Record<string, unknown>)
  }

  return obj
}

function fillIfEmptyOrMissing(obj: Record<string, unknown>, key: string, fallback: string = PLACEHOLDER): void {
  const v = obj[key]
  if (typeof v !== "string" || v.trim() === "") {
    obj[key] = fallback
  }
}

function ensureArray(obj: Record<string, unknown>, key: string): void {
  if (!Array.isArray(obj[key])) {
    obj[key] = []
  }
}

function repairImplementBrief(ib: Record<string, unknown>): void {
  fillIfEmptyOrMissing(ib, "intent")
  ensureArray(ib, "subcomponents")
  ensureArray(ib, "edgeCases")
  ensureArray(ib, "consistencyNotes")
  ensureArray(ib, "buildPlan")

  if (typeof ib.architectureSketch !== "string") ib.architectureSketch = ""

  if (ib.recommendedStack && typeof ib.recommendedStack === "object") {
    const stack = ib.recommendedStack as Record<string, unknown>
    fillIfEmptyOrMissing(stack, "language")
    ensureArray(stack, "frameworks")
    ensureArray(stack, "libraries")
    if (typeof stack.rationale !== "string") stack.rationale = ""
  } else {
    // Missing recommendedStack altogether — provide a minimal placeholder so
    // the schema's `recommendedStack: z.object(...)` requirement passes.
    ib.recommendedStack = {
      language: PLACEHOLDER,
      frameworks: [],
      libraries: [],
      rationale: "",
    }
  }
}

function repairBugBrief(bb: Record<string, unknown>): void {
  fillIfEmptyOrMissing(bb, "symptom")
  fillIfEmptyOrMissing(bb, "suspectedBoundary", "unknown")
  ensureArray(bb, "hypotheses")
  ensureArray(bb, "sideEffects")
  ensureArray(bb, "verificationSteps")

  if (bb.expectedVsActual && typeof bb.expectedVsActual === "object") {
    const eva = bb.expectedVsActual as Record<string, unknown>
    if (typeof eva.expected !== "string") eva.expected = ""
    if (typeof eva.actual !== "string") eva.actual = ""
  } else {
    bb.expectedVsActual = { expected: "", actual: "" }
  }

  // rootCauseGuess is `.nullable()` already — leave as null if missing.
  if (bb.rootCauseGuess === undefined) bb.rootCauseGuess = null

  if (bb.proposedFix && typeof bb.proposedFix === "object") {
    const fix = bb.proposedFix as Record<string, unknown>
    fillIfEmptyOrMissing(fix, "description")
    fillIfEmptyOrMissing(fix, "scope", "minimal")
    ensureArray(fix, "filesAffected")
  } else {
    bb.proposedFix = { description: PLACEHOLDER, scope: "minimal", filesAffected: [] }
  }
}

function repairDecisionBrief(db: Record<string, unknown>): void {
  fillIfEmptyOrMissing(db, "recommendation")
  if (typeof db.proceedHint !== "string") db.proceedHint = ""
  ensureArray(db, "alternatives")
  ensureArray(db, "riskNotes")
}

function repairChunkPlanBrief(cp: Record<string, unknown>): void {
  fillIfEmptyOrMissing(cp, "nextAction")
  if (typeof cp.rationale !== "string" || (cp.rationale as string).trim() === "") {
    cp.rationale = PLACEHOLDER
  }
  ensureArray(cp, "dependencies")
  // files MUST have at least 1 entry per schema. Without one we still let
  // validation fail — empty file list IS a malformed brief, not a near-miss.
  ensureArray(cp, "files")
  if (typeof cp.expectedSizeBin !== "string") cp.expectedSizeBin = "small"
  if (typeof cp.isFinalChunk !== "boolean") cp.isFinalChunk = false
}

function repairChunkReflectionBrief(cr: Record<string, unknown>): void {
  if (typeof cr.coherent !== "boolean") cr.coherent = true
  ensureArray(cr, "issues")
  if (typeof cr.nextFocus !== "string") cr.nextFocus = ""
  if (typeof cr.shouldStop !== "boolean") cr.shouldStop = false
}

function repairDivergenceVerdictBrief(dv: Record<string, unknown>): void {
  if (typeof dv.onTrack !== "boolean") dv.onTrack = true
  if (typeof dv.score !== "number" || !Number.isFinite(dv.score)) dv.score = 100
  ensureArray(dv, "mismatches")
  if (typeof dv.suggestion !== "string") dv.suggestion = "continue"
}

function repairElaborationBrief(eb: Record<string, unknown>): void {
  fillIfEmptyOrMissing(eb, "whyThisApproach")
  ensureArray(eb, "whyNotAlternative")
  ensureArray(eb, "preconditions")
  if (typeof eb.confidence !== "string") eb.confidence = "MEDIUM"
}

function repairSummaryBrief(sb: Record<string, unknown>): void {
  if (typeof sb.audienceLevel !== "string") sb.audienceLevel = "dev"
  ensureArray(sb, "keyFacts")
  ensureArray(sb, "clusters")
  ensureArray(sb, "constraints")
  ensureArray(sb, "whatMatters")
  ensureArray(sb, "whatDoesnt")
  if (sb.hallucinationCheck && typeof sb.hallucinationCheck === "object") {
    const hc = sb.hallucinationCheck as Record<string, unknown>
    ensureArray(hc, "suspect")
    ensureArray(hc, "verified")
  } else {
    sb.hallucinationCheck = { suspect: [], verified: [] }
  }
}
