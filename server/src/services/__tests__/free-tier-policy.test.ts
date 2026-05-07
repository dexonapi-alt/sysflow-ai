import { describe, it, expect } from "vitest"
import {
  isFreeTierModel,
  FREE_MODEL_SENSITIVITY_BUMP,
  FREE_TIER_PREFLIGHT_ELABORATION_ENABLED,
  FREE_TIER_DIVERGENCE_CHAIN_LOWER,
  FREE_TIER_DIVERGENCE_CHAIN_UPPER,
  FREE_TIER_CHUNK_CAP_TIGHTEN,
  FREE_TIER_CHUNK_FILES_TIGHTEN,
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
