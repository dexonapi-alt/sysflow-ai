import { describe, it, expect } from "vitest"
import {
  isFreeTierModel,
  FREE_MODEL_SENSITIVITY_BUMP,
  FREE_TIER_PREFLIGHT_ELABORATION_ENABLED,
  FREE_TIER_DIVERGENCE_CHAIN_LOWER,
  FREE_TIER_DIVERGENCE_CHAIN_UPPER,
  FREE_TIER_CHUNK_CAP_TIGHTEN,
  FREE_TIER_CHUNK_FILES_TIGHTEN,
  shouldRunPreflightElaboration,
  shouldRunDivergenceSecondLook,
  resolveChunkCaps,
  resolveMaxChunksPerRun,
  resolveMaxFilesPerChunk,
} from "../free-tier-policy.js"

describe("isFreeTierModel", () => {
  it("matches openrouter-auto (case-insensitive)", () => {
    expect(isFreeTierModel("openrouter-auto")).toBe(true)
    expect(isFreeTierModel("OpenRouter-Auto")).toBe(true)
    expect(isFreeTierModel("openrouter-auto/llm")).toBe(true)
  })

  it("matches gemini-flash-or", () => {
    expect(isFreeTierModel("gemini-flash-or")).toBe(true)
    expect(isFreeTierModel("Gemini-Flash-OR")).toBe(true)
  })

  it("matches llama / mistral substrings on word boundaries", () => {
    expect(isFreeTierModel("meta-llama/llama-3.1-405b")).toBe(true)
    expect(isFreeTierModel("mistralai/mistral-large")).toBe(true)
    expect(isFreeTierModel("nousresearch/llama-3-tuned")).toBe(true)
  })

  it("avoids false positives on unrelated word fragments", () => {
    expect(isFreeTierModel("alabama-finetune")).toBe(false)
    expect(isFreeTierModel("gpt-4o")).toBe(false)
    expect(isFreeTierModel("claude-3-5-sonnet")).toBe(false)
    expect(isFreeTierModel("gpt-4-turbo")).toBe(false)
  })

  it("returns false on empty / undefined / non-string input", () => {
    expect(isFreeTierModel("")).toBe(false)
    expect(isFreeTierModel(null)).toBe(false)
    expect(isFreeTierModel(undefined)).toBe(false)
    // @ts-expect-error — intentional bad payload
    expect(isFreeTierModel(42)).toBe(false)
  })
})

describe("Phase 16 free-tier policy constants", () => {
  it("FREE_MODEL_SENSITIVITY_BUMP is the Phase 11 default (10)", () => {
    expect(FREE_MODEL_SENSITIVITY_BUMP).toBe(10)
  })

  it("FREE_TIER_PREFLIGHT_ELABORATION_ENABLED defaults true", () => {
    // Stage 3 will read this; Stage 1 only declares it. Default-on so
    // free-tier users get the elaboration without flipping a flag.
    expect(FREE_TIER_PREFLIGHT_ELABORATION_ENABLED).toBe(true)
  })

  it("FREE_TIER_DIVERGENCE_CHAIN band is a sane 0-100 sub-range", () => {
    expect(FREE_TIER_DIVERGENCE_CHAIN_LOWER).toBeGreaterThan(0)
    expect(FREE_TIER_DIVERGENCE_CHAIN_LOWER).toBeLessThan(FREE_TIER_DIVERGENCE_CHAIN_UPPER)
    expect(FREE_TIER_DIVERGENCE_CHAIN_UPPER).toBeLessThan(100)
  })

  it("FREE_TIER_CHUNK_CAP_TIGHTEN is a fraction in (0, 1] — never inflates the cap", () => {
    expect(FREE_TIER_CHUNK_CAP_TIGHTEN).toBeGreaterThan(0)
    expect(FREE_TIER_CHUNK_CAP_TIGHTEN).toBeLessThanOrEqual(1)
  })

  it("FREE_TIER_CHUNK_FILES_TIGHTEN is below the default 5 file cap", () => {
    // The default cap (chunkPlanBriefSchema.files.max(5)) is 5 — Phase 16
    // tightens to 4 for free-tier so the free model has fewer balls in
    // the air per chunk.
    expect(FREE_TIER_CHUNK_FILES_TIGHTEN).toBeGreaterThan(0)
    expect(FREE_TIER_CHUNK_FILES_TIGHTEN).toBeLessThan(5)
  })
})

describe("back-compat: confidence-tracker re-exports the moved symbols", () => {
  it("isFreeTierModel and FREE_MODEL_SENSITIVITY_BUMP are still importable from confidence-tracker", async () => {
    const reexports = await import("../confidence-tracker.js")
    expect(typeof reexports.isFreeTierModel).toBe("function")
    expect(reexports.FREE_MODEL_SENSITIVITY_BUMP).toBe(FREE_MODEL_SENSITIVITY_BUMP)
    // Function identity isn't guaranteed across re-export, but behaviour is.
    expect(reexports.isFreeTierModel("openrouter-auto")).toBe(true)
    expect(reexports.isFreeTierModel("gpt-4o")).toBe(false)
  })
})

// ─── Phase 16 Stage 3: shouldRunPreflightElaboration gate matrix ───

describe("shouldRunPreflightElaboration", () => {
  // Default: free-tier + medium complexity + MEDIUM confidence + flag on → fire.
  const baseHit = {
    model: "openrouter-auto",
    complexity: "medium" as const,
    preflightConfidence: "MEDIUM" as const,
    flagEnabled: true,
  }

  it("fires on the canonical free-tier + medium + MEDIUM + flag-on case", () => {
    expect(shouldRunPreflightElaboration(baseHit)).toBe(true)
  })

  it("fires on free-tier + complex + LOW (the bigger-cost case the elaboration is most needed for)", () => {
    expect(shouldRunPreflightElaboration({ ...baseHit, complexity: "complex", preflightConfidence: "LOW" })).toBe(true)
  })

  it("does NOT fire when the flag is off (off-switch wins)", () => {
    expect(shouldRunPreflightElaboration({ ...baseHit, flagEnabled: false })).toBe(false)
  })

  it("Stage C: fires on paid models too (free-tier-only gate was dropped per user feedback)", () => {
    // Before Stage C of model-lock-and-portable-reasoning this gate was
    // free-tier-only. User feedback: *"every model gets all reasoning not
    // just flash"* — paid claude / GPT runs also benefit from the second
    // look when preflight confidence is uncertain.
    expect(shouldRunPreflightElaboration({ ...baseHit, model: "gpt-4o" })).toBe(true)
    expect(shouldRunPreflightElaboration({ ...baseHit, model: "claude-3-5-sonnet" })).toBe(true)
    expect(shouldRunPreflightElaboration({ ...baseHit, model: "claude-sonnet" })).toBe(true)
    expect(shouldRunPreflightElaboration({ ...baseHit, model: "claude-opus" })).toBe(true)
  })

  it("does NOT fire on simple complexity (over-thinking guard)", () => {
    expect(shouldRunPreflightElaboration({ ...baseHit, complexity: "simple" })).toBe(false)
  })

  it("does NOT fire on HIGH preflight confidence (preflight already certain enough)", () => {
    expect(shouldRunPreflightElaboration({ ...baseHit, preflightConfidence: "HIGH" })).toBe(false)
  })

  it("Stage C: model null/undefined no longer suppresses (free-tier check was dropped); complexity / confidence still gate", () => {
    // After Stage C, model identity doesn't gate the elaboration — only
    // complexity (must be ≥ medium) and preflight confidence (must be < HIGH)
    // do. Null model is fine: the gate fires.
    expect(shouldRunPreflightElaboration({ ...baseHit, model: null })).toBe(true)
    expect(shouldRunPreflightElaboration({ ...baseHit, model: undefined })).toBe(true)
    // Complexity / confidence still defend — null / undefined for those
    // suppresses (they aren't medium/complex or MEDIUM/LOW respectively).
    expect(shouldRunPreflightElaboration({ ...baseHit, complexity: null })).toBe(false)
    expect(shouldRunPreflightElaboration({ ...baseHit, complexity: undefined })).toBe(false)
    expect(shouldRunPreflightElaboration({ ...baseHit, preflightConfidence: null })).toBe(false)
    expect(shouldRunPreflightElaboration({ ...baseHit, preflightConfidence: undefined })).toBe(false)
  })

  it("Stage C: full matrix — fires on (paid|free) × (medium|complex) × (MEDIUM|LOW), model-independent", () => {
    // After Stage C the gate is model-agnostic: paid AND free both fire
    // when complexity ≥ medium AND preflight confidence < HIGH.
    const models = ["gpt-4o" /* paid */, "openrouter-auto" /* free */, "claude-sonnet" /* paid */] as const
    const complexities = ["simple", "medium", "complex"] as const
    const confidences = ["HIGH", "MEDIUM", "LOW"] as const

    for (const model of models) {
      for (const complexity of complexities) {
        for (const preflightConfidence of confidences) {
          const got = shouldRunPreflightElaboration({ model, complexity, preflightConfidence, flagEnabled: true })
          const expected =
            (complexity === "medium" || complexity === "complex")
            && (preflightConfidence === "MEDIUM" || preflightConfidence === "LOW")
          expect(got).toBe(expected)
        }
      }
    }
  })
})

// ─── Phase 16 Stage 4: shouldRunDivergenceSecondLook gate matrix ───

describe("shouldRunDivergenceSecondLook", () => {
  // Default: free-tier + score in band + flag on → fire.
  const baseHit = {
    model: "openrouter-auto",
    firstVerdictScore: 50,
    flagEnabled: true,
  }

  it("fires on the canonical free-tier + borderline-50 + flag-on case", () => {
    expect(shouldRunDivergenceSecondLook(baseHit)).toBe(true)
  })

  it("fires at the band edges (40 and 60 inclusive)", () => {
    expect(shouldRunDivergenceSecondLook({ ...baseHit, firstVerdictScore: FREE_TIER_DIVERGENCE_CHAIN_LOWER })).toBe(true)
    expect(shouldRunDivergenceSecondLook({ ...baseHit, firstVerdictScore: FREE_TIER_DIVERGENCE_CHAIN_UPPER })).toBe(true)
  })

  it("does NOT fire on a clear off-course score (≤39 — already decisive)", () => {
    expect(shouldRunDivergenceSecondLook({ ...baseHit, firstVerdictScore: FREE_TIER_DIVERGENCE_CHAIN_LOWER - 1 })).toBe(false)
    expect(shouldRunDivergenceSecondLook({ ...baseHit, firstVerdictScore: 0 })).toBe(false)
  })

  it("does NOT fire on a clear on-track score (≥61 — no need to second-guess)", () => {
    expect(shouldRunDivergenceSecondLook({ ...baseHit, firstVerdictScore: FREE_TIER_DIVERGENCE_CHAIN_UPPER + 1 })).toBe(false)
    expect(shouldRunDivergenceSecondLook({ ...baseHit, firstVerdictScore: 100 })).toBe(false)
  })

  it("does NOT fire when the flag is off (off-switch wins)", () => {
    expect(shouldRunDivergenceSecondLook({ ...baseHit, flagEnabled: false })).toBe(false)
  })

  it("does NOT fire on a paid model", () => {
    expect(shouldRunDivergenceSecondLook({ ...baseHit, model: "gpt-4o" })).toBe(false)
    expect(shouldRunDivergenceSecondLook({ ...baseHit, model: "claude-3-5-sonnet" })).toBe(false)
  })

  it("does NOT fire on null / undefined / non-finite inputs (defensive)", () => {
    expect(shouldRunDivergenceSecondLook({ ...baseHit, model: null })).toBe(false)
    expect(shouldRunDivergenceSecondLook({ ...baseHit, model: undefined })).toBe(false)
    expect(shouldRunDivergenceSecondLook({ ...baseHit, firstVerdictScore: null })).toBe(false)
    expect(shouldRunDivergenceSecondLook({ ...baseHit, firstVerdictScore: undefined })).toBe(false)
    expect(shouldRunDivergenceSecondLook({ ...baseHit, firstVerdictScore: NaN })).toBe(false)
    expect(shouldRunDivergenceSecondLook({ ...baseHit, firstVerdictScore: Infinity })).toBe(false)
  })

  it("score boundary matrix walks the band edges (39, 40, 60, 61)", () => {
    expect(shouldRunDivergenceSecondLook({ ...baseHit, firstVerdictScore: 39 })).toBe(false)
    expect(shouldRunDivergenceSecondLook({ ...baseHit, firstVerdictScore: 40 })).toBe(true)
    expect(shouldRunDivergenceSecondLook({ ...baseHit, firstVerdictScore: 60 })).toBe(true)
    expect(shouldRunDivergenceSecondLook({ ...baseHit, firstVerdictScore: 61 })).toBe(false)
  })
})

// ─── Phase 16 Stage 5: chunk-cap resolution ───

describe("resolveMaxFilesPerChunk", () => {
  it("returns the schema cap (5) for paid models", () => {
    expect(resolveMaxFilesPerChunk("gpt-4o")).toBe(5)
    expect(resolveMaxFilesPerChunk("claude-3-5-sonnet")).toBe(5)
  })

  it("returns the tightened cap for free-tier models", () => {
    expect(resolveMaxFilesPerChunk("openrouter-auto")).toBe(FREE_TIER_CHUNK_FILES_TIGHTEN)
    expect(resolveMaxFilesPerChunk("meta-llama/llama-3.1-405b")).toBe(FREE_TIER_CHUNK_FILES_TIGHTEN)
    expect(resolveMaxFilesPerChunk("mistralai/mistral-large")).toBe(FREE_TIER_CHUNK_FILES_TIGHTEN)
  })

  it("returns the schema cap (5) on null / undefined / non-string input", () => {
    expect(resolveMaxFilesPerChunk(null)).toBe(5)
    expect(resolveMaxFilesPerChunk(undefined)).toBe(5)
    expect(resolveMaxFilesPerChunk("")).toBe(5)
  })

  it("the tightened cap is below the schema cap (otherwise it's a no-op)", () => {
    expect(FREE_TIER_CHUNK_FILES_TIGHTEN).toBeLessThan(5)
  })
})

describe("resolveMaxChunksPerRun", () => {
  it("returns the base value unchanged for paid models", () => {
    expect(resolveMaxChunksPerRun("gpt-4o", 12)).toBe(12)
    expect(resolveMaxChunksPerRun("claude-3-5-sonnet", 20)).toBe(20)
    expect(resolveMaxChunksPerRun(null, 12)).toBe(12)
  })

  it("multiplies by FREE_TIER_CHUNK_CAP_TIGHTEN for free-tier models (default 0.7)", () => {
    // 12 × 0.7 = 8.4 → floor = 8
    expect(resolveMaxChunksPerRun("openrouter-auto", 12)).toBe(Math.floor(12 * FREE_TIER_CHUNK_CAP_TIGHTEN))
    // 20 × 0.7 = 14 → floor = 14
    expect(resolveMaxChunksPerRun("openrouter-auto", 20)).toBe(Math.floor(20 * FREE_TIER_CHUNK_CAP_TIGHTEN))
  })

  it("never returns less than 1 for free-tier (small base values floor to 1)", () => {
    expect(resolveMaxChunksPerRun("openrouter-auto", 1)).toBe(1) // 1 × 0.7 = 0.7 → floor 0 → max 1
    expect(resolveMaxChunksPerRun("openrouter-auto", 2)).toBe(1) // 2 × 0.7 = 1.4 → floor 1
  })

  it("coerces non-finite / non-positive base to 1", () => {
    expect(resolveMaxChunksPerRun("gpt-4o", NaN)).toBe(1)
    expect(resolveMaxChunksPerRun("gpt-4o", Infinity)).toBe(1)
    expect(resolveMaxChunksPerRun("gpt-4o", 0)).toBe(1)
    expect(resolveMaxChunksPerRun("gpt-4o", -5)).toBe(1)
  })

  it("floors fractional bases (12.7 → 12)", () => {
    expect(resolveMaxChunksPerRun("gpt-4o", 12.7)).toBe(12)
  })
})

describe("resolveChunkCaps — combined helper", () => {
  it("returns both caps in one call for paid", () => {
    const caps = resolveChunkCaps("gpt-4o", 12)
    expect(caps.maxChunks).toBe(12)
    expect(caps.maxFilesPerChunk).toBe(5)
  })

  it("returns both caps in one call for free-tier", () => {
    const caps = resolveChunkCaps("openrouter-auto", 12)
    expect(caps.maxChunks).toBe(Math.floor(12 * FREE_TIER_CHUNK_CAP_TIGHTEN))
    expect(caps.maxFilesPerChunk).toBe(FREE_TIER_CHUNK_FILES_TIGHTEN)
  })

  it("matches the individual helpers' outputs", () => {
    for (const model of ["gpt-4o", "openrouter-auto", "mistralai/mistral-large", null]) {
      for (const base of [1, 5, 12, 20]) {
        const caps = resolveChunkCaps(model, base)
        expect(caps.maxChunks).toBe(resolveMaxChunksPerRun(model, base))
        expect(caps.maxFilesPerChunk).toBe(resolveMaxFilesPerChunk(model))
      }
    }
  })
})
