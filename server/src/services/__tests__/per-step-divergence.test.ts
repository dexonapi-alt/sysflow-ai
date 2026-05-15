/**
 * Stage 4 of free-tier-quality-enforcement plan: per-step divergence
 * for free-tier runs.
 *
 * Two units under test here, both pure:
 *   1. `detectDivergence` with the new `same_action_repeated_in_session`
 *      heuristic (uses the `recentActions` field on DetectorInput).
 *   2. `shouldRunPerStepDivergence` — free-tier-only gate.
 *
 * Tests intentionally don't touch tool-result.ts wiring; the integration
 * test surface there is the chunk-boundary divergence block, which is
 * already covered by the awareness-loop tests. This file covers the
 * heuristic + gate matrix so the inputs the wiring builds are exercised.
 */

import { describe, it, expect } from "vitest"
import { detectDivergence, type DetectorInput } from "../divergence-detector.js"
import { shouldRunPerStepDivergence } from "../free-tier-policy.js"

const baseInput = (over: Partial<DetectorInput> = {}): DetectorInput => ({
  originalPrompt: "do something",
  chunkHistory: [],
  filesModified: [],
  toolErrorCounts: new Map(),
  createdDirs: [],
  completionMessage: null,
  plannedChunkCount: null,
  ...over,
})

describe("same_action_repeated_in_session heuristic", () => {
  it("fires when the same {tool, path} tuple appears 3+ times in a 3-6 turn window", () => {
    const out = detectDivergence(baseInput({
      recentActions: [
        { tool: "edit_file", path: "src/server.ts" },
        { tool: "edit_file", path: "src/server.ts" },
        { tool: "edit_file", path: "src/server.ts" },
      ],
    }))
    const hits = out.filter((s) => s.category === "same_action_repeated_in_session")
    expect(hits).toHaveLength(1)
    expect(hits[0].detail).toContain("edit_file")
    expect(hits[0].detail).toContain("src/server.ts")
    expect(hits[0].severity).toBe("moderate")
  })

  it("does NOT fire below the threshold (2 occurrences)", () => {
    const out = detectDivergence(baseInput({
      recentActions: [
        { tool: "edit_file", path: "src/server.ts" },
        { tool: "edit_file", path: "src/server.ts" },
        { tool: "read_file", path: "src/server.ts" },
      ],
    }))
    expect(out.find((s) => s.category === "same_action_repeated_in_session")).toBeUndefined()
  })

  it("does NOT fire when the same tool hits different paths", () => {
    const out = detectDivergence(baseInput({
      recentActions: [
        { tool: "edit_file", path: "src/a.ts" },
        { tool: "edit_file", path: "src/b.ts" },
        { tool: "edit_file", path: "src/c.ts" },
        { tool: "edit_file", path: "src/d.ts" },
      ],
    }))
    expect(out.find((s) => s.category === "same_action_repeated_in_session")).toBeUndefined()
  })

  it("skips entirely when fewer than 3 actions are available (window too small to judge)", () => {
    const out = detectDivergence(baseInput({
      recentActions: [
        { tool: "edit_file", path: "src/server.ts" },
        { tool: "edit_file", path: "src/server.ts" },
      ],
    }))
    expect(out.find((s) => s.category === "same_action_repeated_in_session")).toBeUndefined()
  })

  it("skips when recentActions is missing or empty", () => {
    const out1 = detectDivergence(baseInput({ recentActions: undefined }))
    const out2 = detectDivergence(baseInput({ recentActions: [] }))
    expect(out1.find((s) => s.category === "same_action_repeated_in_session")).toBeUndefined()
    expect(out2.find((s) => s.category === "same_action_repeated_in_session")).toBeUndefined()
  })

  it("treats run_command repeats by command string, not just tool name", () => {
    const out = detectDivergence(baseInput({
      recentActions: [
        { tool: "run_command", command: "npm test" },
        { tool: "run_command", command: "npm test" },
        { tool: "run_command", command: "npm test" },
      ],
    }))
    const hits = out.filter((s) => s.category === "same_action_repeated_in_session")
    expect(hits).toHaveLength(1)
    expect(hits[0].detail).toContain("npm test")
  })

  it("different commands on the same tool do NOT accumulate", () => {
    const out = detectDivergence(baseInput({
      recentActions: [
        { tool: "run_command", command: "npm test" },
        { tool: "run_command", command: "npm run build" },
        { tool: "run_command", command: "npm run lint" },
      ],
    }))
    expect(out.find((s) => s.category === "same_action_repeated_in_session")).toBeUndefined()
  })

  it("only inspects the last 6 actions even when the log is longer", () => {
    // Three early-occurrence edits to file A (would have fired) followed by
    // six unrelated reads to file B. The window slices to the last 6, so
    // the trailing reads are what we see — and they don't repeat to 3.
    const out = detectDivergence(baseInput({
      recentActions: [
        { tool: "edit_file", path: "src/old.ts" },
        { tool: "edit_file", path: "src/old.ts" },
        { tool: "edit_file", path: "src/old.ts" },
        { tool: "read_file", path: "src/a.ts" },
        { tool: "read_file", path: "src/b.ts" },
        { tool: "read_file", path: "src/c.ts" },
        { tool: "read_file", path: "src/d.ts" },
        { tool: "read_file", path: "src/e.ts" },
        { tool: "read_file", path: "src/f.ts" },
      ],
    }))
    expect(out.find((s) => s.category === "same_action_repeated_in_session")).toBeUndefined()
  })

  it("fires when the loop fills the whole 6-turn window", () => {
    const out = detectDivergence(baseInput({
      recentActions: Array.from({ length: 6 }, () => ({ tool: "edit_file", path: "src/loop.ts" })),
    }))
    const hits = out.filter((s) => s.category === "same_action_repeated_in_session")
    expect(hits).toHaveLength(1)
    expect(hits[0].detail).toMatch(/6.*turns/)
  })

  it("is robust against malformed entries (missing tool / non-string fields)", () => {
    const out = detectDivergence(baseInput({
      recentActions: [
        { tool: "edit_file", path: "src/x.ts" },
        // @ts-expect-error — deliberately malformed at runtime
        { tool: null, path: "src/x.ts" },
        // @ts-expect-error — missing tool entirely
        { path: "src/x.ts" },
        { tool: "edit_file", path: "src/x.ts" },
        { tool: "edit_file", path: "src/x.ts" },
      ],
    }))
    // Two valid edit_file entries to src/x.ts shouldn't be enough; the
    // malformed entries are skipped, leaving 3 valid ones — which IS enough.
    // (We count the three intentionally-typed `edit_file` entries.)
    const hits = out.filter((s) => s.category === "same_action_repeated_in_session")
    expect(hits).toHaveLength(1)
  })
})

describe("shouldRunPerStepDivergence", () => {
  it("returns true for openrouter-auto", () => {
    expect(shouldRunPerStepDivergence("openrouter-auto")).toBe(true)
  })

  it("returns true for llama variants", () => {
    expect(shouldRunPerStepDivergence("meta-llama/llama-3.1-405b")).toBe(true)
    expect(shouldRunPerStepDivergence("openrouter/llama-3-70b")).toBe(true)
  })

  it("returns true for mistral variants", () => {
    expect(shouldRunPerStepDivergence("mistralai/mistral-large")).toBe(true)
  })

  it("returns true for gemini-flash-or routes", () => {
    expect(shouldRunPerStepDivergence("openrouter/gemini-flash-or")).toBe(true)
  })

  it("returns false for paid models", () => {
    expect(shouldRunPerStepDivergence("claude-sonnet-4-6")).toBe(false)
    expect(shouldRunPerStepDivergence("claude-opus-4-7")).toBe(false)
    expect(shouldRunPerStepDivergence("gpt-4o")).toBe(false)
    expect(shouldRunPerStepDivergence("gemini-2.5-pro")).toBe(false)
  })

  it("returns false for null / undefined / empty model", () => {
    expect(shouldRunPerStepDivergence(null)).toBe(false)
    expect(shouldRunPerStepDivergence(undefined)).toBe(false)
    expect(shouldRunPerStepDivergence("")).toBe(false)
  })
})
