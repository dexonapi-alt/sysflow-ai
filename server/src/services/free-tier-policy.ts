/**
 * Phase 16: central policy module for free-tier model adaptation.
 *
 * Phase 11 introduced `isFreeTierModel` + `FREE_MODEL_SENSITIVITY_BUMP`
 * inside `confidence-tracker.ts`. Phase 16 promotes them to a dedicated
 * module so future free-tier-aware code paths (chained reasoning,
 * tightened chunk caps, complexity-adaptive depth) all have a single
 * place to look + extend, rather than each Phase 16+ stage adding new
 * `isFreeTierModel` calls scattered across services.
 *
 * `confidence-tracker.ts` re-exports the Phase 11 constants for
 * back-compat — existing importers don't need to change.
 *
 * Behavioural defaults live HERE; flag-overridable knobs (thresholds
 * users actually tune) live in `flags.ts`.
 */

/** Phase 11 Stage 7: how many points to bump both awareness thresholds
 *  when the run's model is free-tier. */
export const FREE_MODEL_SENSITIVITY_BUMP = 10

/** Phase 16 Stage 3: gate the chained `implement_elaborate` Flash call
 *  on free-tier + complexity ≥ medium + preflight confidence < HIGH.
 *  Default true — the elaboration is what makes free models think
 *  deeply enough to ship quality output. Disable via the flag system if
 *  free-tier rate limits make the extra Flash too expensive. */
export const FREE_TIER_PREFLIGHT_ELABORATION_ENABLED = true

/** Phase 16 Stage 4: when free-tier AND the heuristic+gate signals
 *  produce a borderline score (40 ≤ score ≤ 60), run a chained
 *  second-look divergence Flash. Constants here are the BAND endpoints;
 *  the band check lives in tool-result.ts. */
export const FREE_TIER_DIVERGENCE_CHAIN_LOWER = 40
export const FREE_TIER_DIVERGENCE_CHAIN_UPPER = 60

/** Phase 16 Stage 5: chunk cap multiplier for free-tier. The flag
 *  `reasoning.max_chunks_per_run` (default 12) gets multiplied by this
 *  for free-tier runs — 12 × 0.7 = 8 chunks. Tighter cap is conservative
 *  about how much a free model can do well in one go. */
export const FREE_TIER_CHUNK_CAP_TIGHTEN = 0.7

/** Phase 16 Stage 5: per-chunk file cap for free-tier. The default
 *  `chunkPlanBriefSchema.files.max(5)` gets dropped to 4 for free-tier
 *  so the free model has fewer balls in the air per chunk. */
export const FREE_TIER_CHUNK_FILES_TIGHTEN = 4

/**
 * True when the run's model identifier looks like a free-tier OpenRouter
 * route or one of the free-tier-class providers the Phase 11 plan
 * explicitly called out (LLaMA / Mistral substring matches). False for
 * empty / undefined inputs so a missing model field never trips the
 * free-tier path.
 *
 * Substring matching is intentional. False positives are tolerable —
 * the cost of treating a paid LLaMA fine-tune as free-tier is one extra
 * Flash call per turn (Stage 3 elaboration), which is cheap. False
 * negatives (treating a genuinely free model as paid) silently skip the
 * adaptation, which is exactly what Phase 16 is preventing.
 */
export function isFreeTierModel(model: string | null | undefined): boolean {
  if (!model || typeof model !== "string") return false
  const lower = model.toLowerCase()
  if (lower.includes("openrouter-auto")) return true
  if (lower.includes("gemini-flash-or")) return true
  // Loose substring matches — `meta-llama/llama-3.1-405b` and
  // `mistralai/mistral-large` both qualify. Word boundaries avoid
  // matches inside unrelated words like "alabama" or "mistralian".
  if (/\b(?:llama|mistral)\b/.test(lower)) return true
  return false
}

/**
 * Phase 16 Stage 3: should the chained preflight elaboration fire for
 * this run? All four conditions must hold:
 *
 *   1. The run's model is free-tier (otherwise the preflight Flash is
 *      already strong enough; no need to chain).
 *   2. Task complexity is medium or complex (simple tasks aren't worth
 *      a second Flash — over-thinking a typo fix wastes the budget).
 *   3. Preflight confidence was MEDIUM or LOW (HIGH means the preflight
 *      is already certain enough; chaining adds no signal).
 *   4. The flag `reasoning.chained.preflight_elaboration_enabled` is on.
 *
 * Pure helper — exported so the gate matrix is unit-testable without
 * invoking `runReasoning`.
 */
export interface PreflightElaborationGateInput {
  /** Run's model identifier (e.g. `"openrouter-auto"`, `"gpt-4o"`). */
  model: string | null | undefined
  /** Output of `analyzeTaskComplexity(prompt).complexity`. */
  complexity: "simple" | "medium" | "complex" | null | undefined
  /** Preflight envelope's confidence ("HIGH" / "MEDIUM" / "LOW"). */
  preflightConfidence: "HIGH" | "MEDIUM" | "LOW" | null | undefined
  /** Resolved value of `reasoning.chained.preflight_elaboration_enabled`. */
  flagEnabled: boolean
}

export function shouldRunPreflightElaboration(input: PreflightElaborationGateInput): boolean {
  if (!input.flagEnabled) return false
  // Stage C of model-lock-and-portable-reasoning: dropped the
  // `isFreeTierModel` gate. User feedback was *"every model gets all
  // reasoning not just flash"* — the elaboration's value (re-examining
  // the stack pick under a different lens) is not tier-specific. Cost
  // guards remain: only fires for real implement complexity AND when
  // preflight confidence is below HIGH. Free-tier-class models still
  // benefit most, but paid claude / GPT runs now get the same second
  // look when the preflight is genuinely uncertain.
  if (input.complexity !== "medium" && input.complexity !== "complex") return false
  if (input.preflightConfidence !== "MEDIUM" && input.preflightConfidence !== "LOW") return false
  return true
}

/**
 * Stage C of model-lock-and-portable-reasoning: should an iterative
 * refine pass fire after the initial reasoner call?
 *
 * Refine is a generic mechanism: a second reasoner invocation that takes
 * the first draft as input, critiques the reasoningChain, and outputs a
 * revised envelope. Costs 2x reasoner spend per call but addresses the
 * user feedback *"reason over and over again like normal AI would"* —
 * single-pass briefs often miss alternatives or trade-offs the model
 * surfaces on a second look.
 *
 * Gate logic — apply in this order:
 *   1. Flag must be on (kill switch for cost-constrained users).
 *   2. Pipeline kind must benefit from refinement:
 *      - implement / bug / decision / chunk_plan / chunk_reflect: YES
 *      - summary: NO (user-facing prose, second pass risks meta-summarising)
 *      - implement_elaborate: NO (it IS the second look — don't third-look it)
 *      - divergence: NO (Phase 16 Stage 4 already gates a second-look)
 *
 * Reasoner-backend-agnostic on purpose — same gate fires regardless of
 * which backend (Gemini, Anthropic Haiku in Stage D, OpenRouter free)
 * serves the call. When Stage D lands, the refine pass goes through the
 * same dispatcher as the initial call.
 *
 * Pure helper — exported so the gate matrix is unit-testable without
 * invoking `runReasoning`.
 */
export interface IterativeRefineGateInput {
  /** The pipeline being run (implement / bug / decision / chunk_plan / chunk_reflect / divergence / implement_elaborate / summary). */
  kind: string
  /** Run's model identifier — not currently used in the gate, kept for future tuning. */
  model: string | null | undefined
  /** Resolved value of `reasoning.iterative_refine_enabled`. */
  flagEnabled: boolean
  /**
   * Stage C: task complexity from `analyzeTaskComplexity(prompt).complexity`.
   * "simple" / trivial tasks skip the refine pass — user feedback:
   * *"when super easy task and so obvious it doesnt need to reason deeply"*.
   * `undefined` / `null` defaults to running refine (don't accidentally
   * skip on missing data — the gate should be additive).
   */
  complexity?: "simple" | "medium" | "complex" | null
}

export function shouldRunIterativeRefine(input: IterativeRefineGateInput): boolean {
  if (!input.flagEnabled) return false
  if (input.kind === "summary") return false
  if (input.kind === "implement_elaborate") return false
  if (input.kind === "divergence") return false
  // Stage C: complexity guard. Trivial tasks (typo fixes, single-line
  // renames, "add a console.log") don't benefit from a critique-and-revise
  // pass — the LLM also gauges this in `DEEP_REASONING_PROMPT` so the
  // chain itself stays brief, but skipping the refine pass entirely is
  // the system-level safety net that ensures budget never gets spent on
  // overthinking the obvious.
  if (input.complexity === "simple") return false
  return true
}

/**
 * Iterative paragraph chain mode (paragraph-by-paragraph reasoning).
 *
 * User feedback that drove this: *"reason it one by one → call llm →
 * reason 2nd → reason 3rd time → repeat until done. what i say deep
 * reasoning is for the ai agent reason → call llm to reason → repeat
 * until done."*
 *
 * When this gate fires, the reasoner produces its chain across N
 * sequential Flash calls (one paragraph per call, each seeing prior
 * paragraphs + allowed to revise them for anti-staleness). Total cost
 * is N+1 Flash calls per preflight versus 1 today, so the gate is
 * conservative about WHEN to fire:
 *
 *   1. Flag must be on (kill switch for cost-constrained users).
 *   2. Pipeline kind benefits from full paragraph deliberation:
 *      - implement / bug / decision: YES (the deep cases)
 *      - chunk_plan / chunk_reflect: NO (fire per chunk — too expensive
 *        for a 10-chunk run; chunked-loop pipelines stay one-shot)
 *      - summary / implement_elaborate / divergence: NO (existing skip)
 *   3. Complexity must be medium or complex. Simple tasks already use
 *      a brief 1-2 paragraph chain in one shot; iterating them would
 *      cost more than they're worth.
 *
 * Pure helper — exported so the gate matrix is unit-testable.
 */
export interface IterativeChainGateInput {
  /** The pipeline being run. */
  kind: string
  /** Run's model identifier — not currently consulted, kept for future tuning. */
  model: string | null | undefined
  /** Resolved value of `reasoning.iterative_paragraph_chain_enabled`. */
  flagEnabled: boolean
  /** Task complexity from `analyzeTaskComplexity(prompt).complexity`. */
  complexity?: "simple" | "medium" | "complex" | null
}

export function shouldRunIterativeChain(input: IterativeChainGateInput): boolean {
  if (!input.flagEnabled) return false
  // Skip pipelines where N+1 Flash calls is wasteful or doesn't fit.
  if (input.kind === "summary") return false
  if (input.kind === "implement_elaborate") return false
  if (input.kind === "divergence") return false
  if (input.kind === "chunk_plan") return false
  if (input.kind === "chunk_reflect") return false
  // Trivial-task guard: simple tasks get a brief chain anyway via the
  // depth-awareness instruction in DEEP_REASONING_PROMPT; iterating
  // them N times is wasted budget.
  if (input.complexity === "simple") return false
  // Reasoner-backend-agnostic: paragraph-by-paragraph works the same
  // on Gemini Flash, Anthropic Haiku (Stage D), or OpenRouter free.
  return true
}

/**
 * Phase 16 Stage 4: should the chained divergence second-look fire after
 * a borderline first verdict? All four conditions must hold:
 *
 *   1. The flag `reasoning.chained.divergence_second_look_enabled` is on.
 *   2. The run's model is free-tier.
 *   3. The first verdict's score lands in the borderline band
 *      [FREE_TIER_DIVERGENCE_CHAIN_LOWER, FREE_TIER_DIVERGENCE_CHAIN_UPPER]
 *      (currently 40-60). Clear off-course (≤ lower) is already
 *      decisive; clear on-track (≥ upper) doesn't need second-guessing.
 *   4. The first verdict's score is a valid number.
 *
 * Pure helper — testable without invoking `runReasoning`.
 */
export interface DivergenceSecondLookGateInput {
  /** Run's model identifier. */
  model: string | null | undefined
  /** First divergence verdict's score (0-100). */
  firstVerdictScore: number | null | undefined
  /** Resolved value of `reasoning.chained.divergence_second_look_enabled`. */
  flagEnabled: boolean
}

export function shouldRunDivergenceSecondLook(input: DivergenceSecondLookGateInput): boolean {
  if (!input.flagEnabled) return false
  if (!isFreeTierModel(input.model)) return false
  const score = input.firstVerdictScore
  if (typeof score !== "number" || !Number.isFinite(score)) return false
  if (score < FREE_TIER_DIVERGENCE_CHAIN_LOWER) return false
  if (score > FREE_TIER_DIVERGENCE_CHAIN_UPPER) return false
  return true
}

/**
 * Phase 16 Stage 5: resolve the chunked-loop caps for the run's model.
 *
 * Free-tier runs use tighter caps to keep each chunk inside the
 * affordable budget AND give the free model fewer balls in the air per
 * chunk. Paid runs keep the original flag values + the schema's hard
 * 5-file maximum.
 *
 * Pure helper — no flag reads, no I/O. Caller passes the resolved base
 * `max_chunks_per_run` flag value; we apply the multiplier here and
 * floor to at least 1 chunk so a tiny base value can't zero out.
 *
 * Mirrors the constants declared in this module:
 *   - `FREE_TIER_CHUNK_CAP_TIGHTEN`  (default 0.7 — 12 → 8 chunks)
 *   - `FREE_TIER_CHUNK_FILES_TIGHTEN` (default 4 — vs schema cap 5)
 */
export interface ChunkCaps {
  /** Effective per-run chunk cap after tightening. */
  maxChunks: number
  /** Effective per-chunk file cap after tightening. */
  maxFilesPerChunk: number
}

export function resolveChunkCaps(model: string | null | undefined, baseMaxChunks: number): ChunkCaps {
  return {
    maxChunks: resolveMaxChunksPerRun(model, baseMaxChunks),
    maxFilesPerChunk: resolveMaxFilesPerChunk(model),
  }
}

/** Phase 16 Stage 5: resolve the per-run chunk cap. Free-tier multiplies
 *  the base by `FREE_TIER_CHUNK_CAP_TIGHTEN` (default 0.7). Floors to at
 *  least 1 so a tiny base value can't zero out. */
export function resolveMaxChunksPerRun(model: string | null | undefined, baseMaxChunks: number): number {
  const base = (typeof baseMaxChunks === "number" && Number.isFinite(baseMaxChunks) && baseMaxChunks >= 1)
    ? Math.floor(baseMaxChunks)
    : 1
  if (!isFreeTierModel(model)) return base
  return Math.max(1, Math.floor(base * FREE_TIER_CHUNK_CAP_TIGHTEN))
}

/** Phase 16 Stage 5: resolve the per-chunk file cap. Paid-tier returns
 *  the schema's hard maximum (5); free-tier drops to
 *  `FREE_TIER_CHUNK_FILES_TIGHTEN` (default 4). */
export function resolveMaxFilesPerChunk(model: string | null | undefined): number {
  return isFreeTierModel(model) ? FREE_TIER_CHUNK_FILES_TIGHTEN : 5
}
