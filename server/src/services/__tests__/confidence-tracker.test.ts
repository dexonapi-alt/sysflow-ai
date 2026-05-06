import { describe, it, expect, beforeEach, afterEach } from "vitest"
import {
  recordSignals,
  getConfidence,
  getConfidenceState,
  getThresholdState,
  clearConfidence,
  isFreeTierModel,
  INITIAL_SCORE,
  FREE_MODEL_SENSITIVITY_BUMP,
  _resetForTests,
} from "../confidence-tracker.js"
import type { DivergenceSignal } from "../divergence-detector.js"
import { resetFlagCache } from "../flags.js"

const sig = (over: Partial<DivergenceSignal> = {}): DivergenceSignal => ({
  category: "same_file_edited_repeatedly",
  detail: "test signal",
  severity: "moderate",
  ...over,
})

describe("confidence-tracker", () => {
  beforeEach(() => {
    _resetForTests()
    // Clear any env overrides leaking from prior tests.
    delete process.env.SYSFLOW_FLAG_AWARENESS_THRESHOLD_OFF_COURSE
    delete process.env.SYSFLOW_FLAG_AWARENESS_THRESHOLD_BLOCKED
    resetFlagCache()
  })

  afterEach(() => {
    delete process.env.SYSFLOW_FLAG_AWARENESS_THRESHOLD_OFF_COURSE
    delete process.env.SYSFLOW_FLAG_AWARENESS_THRESHOLD_BLOCKED
    resetFlagCache()
  })

  it("returns INITIAL_SCORE for an unknown run", () => {
    expect(getConfidence("unknown")).toBe(INITIAL_SCORE)
    expect(getConfidenceState("unknown")).toBeNull()
  })

  it("starts a fresh run at 100 in the on_track state", () => {
    recordSignals("r1", []) // no-op signal pass to materialise state
    expect(getConfidence("r1")).toBe(100)
    expect(getThresholdState("r1")).toBe("on_track")
  })

  it("decays the score by category weight × severity multiplier", () => {
    // intent_keyword_absent base = 25, severity major = 1.0 → -25 → 75
    recordSignals("r1", [sig({ category: "intent_keyword_absent", severity: "major" })])
    expect(getConfidence("r1")).toBe(75)
  })

  it("applies the moderate (0.75) multiplier when severity is unspecified", () => {
    // mkdir_empty_at_chunk_boundary base = 5, undefined severity → 0.75 multiplier → -3.75 → 96.25
    recordSignals("r1", [{ category: "mkdir_empty_at_chunk_boundary", detail: "x" }])
    expect(getConfidence("r1")).toBeCloseTo(96.25)
  })

  it("clamps the score at 0 — never goes negative", () => {
    // Pile on enough major intent signals to overshoot 100 in deduction.
    const sigs: DivergenceSignal[] = Array.from({ length: 10 }, () => sig({
      category: "intent_keyword_absent",
      severity: "major",
    }))
    recordSignals("r1", sigs)
    expect(getConfidence("r1")).toBe(0)
  })

  it("transitions on_track → off_course → blocked at the default thresholds", () => {
    // off_course default = 60, blocked default = 30
    recordSignals("r1", [sig({ category: "intent_keyword_absent", severity: "major" })]) // 100 → 75
    expect(getThresholdState("r1")).toBe("on_track")

    recordSignals("r1", [sig({ category: "intent_keyword_absent", severity: "major" })]) // 75 → 50
    expect(getThresholdState("r1")).toBe("off_course")

    recordSignals("r1", [sig({ category: "intent_keyword_absent", severity: "major" })]) // 50 → 25
    expect(getThresholdState("r1")).toBe("blocked")
  })

  it("respects flag-overridden thresholds", () => {
    // Make the gates much tighter than the defaults: off_course at 90, blocked at 70.
    process.env.SYSFLOW_FLAG_AWARENESS_THRESHOLD_OFF_COURSE = "90"
    process.env.SYSFLOW_FLAG_AWARENESS_THRESHOLD_BLOCKED = "70"
    resetFlagCache()

    // scope_creep base 8 × 0.5 minor = -4 → 96. 96 ≥ 90 → still on_track.
    recordSignals("r1", [sig({ category: "scope_creep", severity: "minor" })])
    expect(getConfidence("r1")).toBe(96)
    expect(getThresholdState("r1")).toBe("on_track")

    // Add intent_keyword_absent base 25 × 0.5 minor = -12.5 → 83.5. 83.5 < 90 → off_course.
    recordSignals("r1", [sig({ category: "intent_keyword_absent", severity: "minor" })])
    expect(getThresholdState("r1")).toBe("off_course")

    // Knock another -25 (major) → 58.5. 58.5 < 70 → blocked.
    recordSignals("r1", [sig({ category: "intent_keyword_absent", severity: "major" })])
    expect(getThresholdState("r1")).toBe("blocked")
  })

  it("isolates state per runId", () => {
    recordSignals("r1", [sig({ category: "intent_keyword_absent", severity: "major" })]) // -25 → 75
    recordSignals("r2", []) // untouched
    expect(getConfidence("r1")).toBe(75)
    expect(getConfidence("r2")).toBe(100)
  })

  it("accumulates the signal log across calls", () => {
    recordSignals("r1", [sig({ detail: "first" })])
    recordSignals("r1", [sig({ detail: "second" }), sig({ detail: "third" })])
    const state = getConfidenceState("r1")!
    expect(state.signals.map((s) => s.detail)).toEqual(["first", "second", "third"])
  })

  it("clearConfidence wipes a single run's state", () => {
    recordSignals("r1", [sig({ category: "intent_keyword_absent", severity: "major" })])
    recordSignals("r2", [sig({ category: "intent_keyword_absent", severity: "major" })])
    clearConfidence("r1")
    expect(getConfidence("r1")).toBe(INITIAL_SCORE)
    expect(getConfidence("r2")).toBe(75)
  })

  it("recordSignals returns the post-deduction score", () => {
    const after = recordSignals("r1", [sig({ category: "intent_keyword_absent", severity: "major" })])
    expect(after).toBe(75)
  })

  it("decays for the Phase 11 Stage 3 llm_off_track category at the same weight as keyword-absent", () => {
    // llm_off_track base 25 × moderate 0.75 = 18.75 → 81.25
    recordSignals("r1", [sig({ category: "llm_off_track", severity: "moderate" })])
    expect(getConfidence("r1")).toBeCloseTo(81.25)
  })

  // ─── Phase 11 Stage 7: free-model threshold sensitivity bump ───

  it("Stage 7: bumps both thresholds by FREE_MODEL_SENSITIVITY_BUMP for free-tier models", () => {
    // Defaults are off_course=60, blocked=30. With bump=10 they become 70 and 40.
    // Score 65 is on_track for paid models (≥60), off_course for free (≥40 but <70).
    recordSignals("r1", [sig({ category: "intent_keyword_absent", severity: "moderate" })]) // 25*0.75=-18.75 → 81.25
    recordSignals("r1", [sig({ category: "intent_keyword_absent", severity: "moderate" })]) // -18.75 → 62.5
    expect(getConfidence("r1")).toBeCloseTo(62.5)
    // Paid model (no model arg, or non-matching name): 62.5 ≥ 60 → on_track
    expect(getThresholdState("r1")).toBe("on_track")
    expect(getThresholdState("r1", null, "claude-3-5-sonnet")).toBe("on_track")
    // Free model: thresholds become 70 / 40 → 62.5 < 70, ≥ 40 → off_course
    expect(getThresholdState("r1", null, "openrouter-auto")).toBe("off_course")
    expect(FREE_MODEL_SENSITIVITY_BUMP).toBe(10)
  })

  it("Stage 7: bump pushes a borderline score into blocked on free models", () => {
    // Knock confidence down to ~37 — blocked on free (<40), off_course on paid (<60 but ≥30).
    for (let i = 0; i < 4; i++) {
      recordSignals("r1", [sig({ category: "intent_keyword_absent", severity: "moderate" })])
    }
    // 100 → 81.25 → 62.5 → 43.75 → 25 ... wait, that's 25 after 4 calls.
    // Let me use 3 calls: 100 → 81.25 → 62.5 → 43.75. That's blocked on free (<40 is false, 43.75 ≥ 40 → off_course).
    // Need EXACTLY between 30 (paid blocked) and 40 (free blocked). Score 35 fits.
    // Restart with a clean state to construct that score precisely.
    _resetForTests()
    recordSignals("r2", [sig({ category: "scope_creep", severity: "minor" })]) // 8*0.5=-4 → 96
    // Knock down 61 more points. intent_keyword_absent major = 25. Three of those = -75 → 21.
    // Use minor (12.5) and moderate (18.75) to land near 35.
    recordSignals("r2", [sig({ category: "intent_keyword_absent", severity: "major" })])  // -25 → 71
    recordSignals("r2", [sig({ category: "intent_keyword_absent", severity: "major" })])  // -25 → 46
    recordSignals("r2", [sig({ category: "scope_creep", severity: "moderate" })])         // 8*0.75=-6 → 40
    recordSignals("r2", [sig({ category: "mkdir_empty_at_chunk_boundary", severity: "minor" })]) // 5*0.5=-2.5 → 37.5
    // Score = 37.5: paid → off_course (≥30), free → blocked (<40)
    expect(getConfidence("r2")).toBeCloseTo(37.5)
    expect(getThresholdState("r2", null, "claude-3-5-sonnet")).toBe("off_course")
    expect(getThresholdState("r2", null, "meta-llama/llama-3.1-405b")).toBe("blocked")
  })
})

describe("isFreeTierModel", () => {
  it("matches the openrouter-auto route", () => {
    expect(isFreeTierModel("openrouter-auto")).toBe(true)
    expect(isFreeTierModel("OpenRouter-Auto")).toBe(true)
  })

  it("matches gemini-flash-or", () => {
    expect(isFreeTierModel("gemini-flash-or")).toBe(true)
  })

  it("matches llama family loosely", () => {
    expect(isFreeTierModel("meta-llama/llama-3.1-405b")).toBe(true)
    expect(isFreeTierModel("nousresearch/llama-3-tuned")).toBe(true)
  })

  it("matches mistral family loosely", () => {
    expect(isFreeTierModel("mistralai/mistral-large")).toBe(true)
  })

  it("does NOT match paid OpenAI / Anthropic models", () => {
    expect(isFreeTierModel("gpt-4o")).toBe(false)
    expect(isFreeTierModel("claude-3-5-sonnet")).toBe(false)
    expect(isFreeTierModel("gpt-4-turbo")).toBe(false)
  })

  it("does NOT match strings that merely contain a vowel substring of llama", () => {
    // Word boundary keeps `\bllama\b` from grabbing "alabama" or similar.
    expect(isFreeTierModel("alabama-finetune")).toBe(false)
  })
})
