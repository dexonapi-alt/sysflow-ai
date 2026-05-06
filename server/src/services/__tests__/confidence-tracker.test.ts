import { describe, it, expect, beforeEach, afterEach } from "vitest"
import {
  recordSignals,
  getConfidence,
  getConfidenceState,
  getThresholdState,
  clearConfidence,
  INITIAL_SCORE,
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
})
