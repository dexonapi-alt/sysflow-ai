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
