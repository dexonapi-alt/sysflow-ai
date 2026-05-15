import { describe, it, expect, beforeEach } from "vitest"
import {
  shouldForceSelfReview,
  markReviewFired,
  getLastReviewIndex,
  clearReviewState,
  buildReviewBlock,
  _resetReviewStateForTests,
} from "../self-review-scheduler.js"
import { getSelfReviewCadence } from "../free-tier-policy.js"

/**
 * Stage 3 of free-tier quality enforcement: mandatory self-review
 * cadence tracker + block generator.
 */

beforeEach(() => _resetReviewStateForTests())

describe("shouldForceSelfReview — cadence", () => {
  it("returns false when the flag is off", () => {
    expect(shouldForceSelfReview({
      runId: "r1", chunkIndex: 5, cadence: 2, flagEnabled: false,
    })).toBe(false)
  })

  it("returns false when chunkIndex is invalid (-1, NaN, negative)", () => {
    expect(shouldForceSelfReview({
      runId: "r1", chunkIndex: -1, cadence: 2, flagEnabled: true,
    })).toBe(false)
    expect(shouldForceSelfReview({
      runId: "r1", chunkIndex: NaN, cadence: 2, flagEnabled: true,
    })).toBe(false)
  })

  it("returns false when cadence is invalid (0, negative, NaN)", () => {
    expect(shouldForceSelfReview({
      runId: "r1", chunkIndex: 5, cadence: 0, flagEnabled: true,
    })).toBe(false)
    expect(shouldForceSelfReview({
      runId: "r1", chunkIndex: 5, cadence: -1, flagEnabled: true,
    })).toBe(false)
  })

  it("fresh run + cadence 2: fires at chunk 1 (chunkIndex - (-1) = 2 >= 2)", () => {
    // Chunk 0 hasn't elapsed enough.
    expect(shouldForceSelfReview({
      runId: "r1", chunkIndex: 0, cadence: 2, flagEnabled: true,
    })).toBe(false)
    // Chunk 1: 1 - (-1) = 2 >= 2 → fire.
    expect(shouldForceSelfReview({
      runId: "r1", chunkIndex: 1, cadence: 2, flagEnabled: true,
    })).toBe(true)
  })

  it("fresh run + cadence 4: fires at chunk 3", () => {
    for (const i of [0, 1, 2]) {
      expect(shouldForceSelfReview({
        runId: "r1", chunkIndex: i, cadence: 4, flagEnabled: true,
      })).toBe(false)
    }
    expect(shouldForceSelfReview({
      runId: "r1", chunkIndex: 3, cadence: 4, flagEnabled: true,
    })).toBe(true)
  })

  it("after markReviewFired, won't re-fire until cadence elapses again", () => {
    markReviewFired("r1", 3)
    // chunk 4: 4 - 3 = 1 < 4 (paid cadence)
    expect(shouldForceSelfReview({
      runId: "r1", chunkIndex: 4, cadence: 4, flagEnabled: true,
    })).toBe(false)
    expect(shouldForceSelfReview({
      runId: "r1", chunkIndex: 6, cadence: 4, flagEnabled: true,
    })).toBe(false)
    // chunk 7: 7 - 3 = 4 >= 4 → fire
    expect(shouldForceSelfReview({
      runId: "r1", chunkIndex: 7, cadence: 4, flagEnabled: true,
    })).toBe(true)
  })

  it("free-tier cadence 2: fires every 2 chunks after the first review", () => {
    // First: chunk 1 fires
    markReviewFired("r1", 1)
    // chunk 2: 2 - 1 = 1 < 2
    expect(shouldForceSelfReview({
      runId: "r1", chunkIndex: 2, cadence: 2, flagEnabled: true,
    })).toBe(false)
    // chunk 3: 3 - 1 = 2 >= 2 → fire
    expect(shouldForceSelfReview({
      runId: "r1", chunkIndex: 3, cadence: 2, flagEnabled: true,
    })).toBe(true)
  })

  it("isolates per-runId state (one run's review doesn't affect another)", () => {
    markReviewFired("run-A", 5)
    // run-A should not fire at chunk 6 (cadence 2: 6 - 5 = 1 < 2)
    expect(shouldForceSelfReview({
      runId: "run-A", chunkIndex: 6, cadence: 2, flagEnabled: true,
    })).toBe(false)
    // run-B is fresh — fires at chunk 1
    expect(shouldForceSelfReview({
      runId: "run-B", chunkIndex: 1, cadence: 2, flagEnabled: true,
    })).toBe(true)
  })
})

describe("markReviewFired + getLastReviewIndex", () => {
  it("getLastReviewIndex returns -1 for runs that have never had a review", () => {
    expect(getLastReviewIndex("never-reviewed")).toBe(-1)
  })

  it("after markReviewFired, getLastReviewIndex returns the recorded chunk", () => {
    markReviewFired("r1", 3)
    expect(getLastReviewIndex("r1")).toBe(3)
  })

  it("markReviewFired ignores invalid chunkIndex (NaN, negative)", () => {
    markReviewFired("r1", NaN)
    expect(getLastReviewIndex("r1")).toBe(-1)
    markReviewFired("r1", -5)
    expect(getLastReviewIndex("r1")).toBe(-1)
  })

  it("subsequent markReviewFired calls update to the latest chunk", () => {
    markReviewFired("r1", 2)
    markReviewFired("r1", 5)
    expect(getLastReviewIndex("r1")).toBe(5)
  })
})

describe("clearReviewState", () => {
  it("resets a specific run only", () => {
    markReviewFired("run-A", 3)
    markReviewFired("run-B", 7)
    clearReviewState("run-A")
    expect(getLastReviewIndex("run-A")).toBe(-1)
    expect(getLastReviewIndex("run-B")).toBe(7)
  })
})

describe("getSelfReviewCadence — tier-aware", () => {
  it("free-tier models get cadence 2", () => {
    expect(getSelfReviewCadence("openrouter-auto")).toBe(2)
    expect(getSelfReviewCadence("meta-llama/llama-3.1-405b")).toBe(2)
    expect(getSelfReviewCadence("mistralai/mistral-large")).toBe(2)
    expect(getSelfReviewCadence("gemini-flash-or")).toBe(2)
  })

  it("paid models get cadence 4", () => {
    expect(getSelfReviewCadence("claude-sonnet")).toBe(4)
    expect(getSelfReviewCadence("claude-opus")).toBe(4)
    expect(getSelfReviewCadence("gemini-flash")).toBe(4)
    expect(getSelfReviewCadence("gpt-4o")).toBe(4)
  })

  it("null/undefined model defaults to cadence 4 (paid behaviour)", () => {
    expect(getSelfReviewCadence(null)).toBe(4)
    expect(getSelfReviewCadence(undefined)).toBe(4)
  })
})

describe("buildReviewBlock — content", () => {
  it("includes the chunk index in the header", () => {
    const out = buildReviewBlock({ filesToReview: ["a.ts"], chunkIndex: 5 })
    expect(out).toContain("REVIEW REQUIRED")
    expect(out).toContain("after chunk 5")
  })

  it("lists files to review in a batch_read directive", () => {
    const out = buildReviewBlock({
      filesToReview: ["src/App.tsx", "src/index.tsx"],
      chunkIndex: 1,
    })
    expect(out).toContain("`batch_read`")
    expect(out).toContain("- src/App.tsx")
    expect(out).toContain("- src/index.tsx")
  })

  it("caps the file list at 6", () => {
    const many = Array.from({ length: 10 }, (_, i) => `file${i}.ts`)
    const out = buildReviewBlock({ filesToReview: many, chunkIndex: 1 })
    expect(out).toContain("- file0.ts")
    expect(out).toContain("- file5.ts")
    expect(out).not.toContain("- file6.ts")
  })

  it("falls back to a 'list files yourself' directive when no files provided", () => {
    const out = buildReviewBlock({ filesToReview: [], chunkIndex: 1 })
    expect(out).toContain("consult the TASK LEDGER")
    // No file-bullet lines (which would be `   - filename`); the closing
    // reasoningChain bullets use ` - ` differently and aren't filenames.
    expect(out).not.toMatch(/^   - \S+\.\w+$/m)
  })

  it("instructs DO NOT WRITE this turn", () => {
    const out = buildReviewBlock({ filesToReview: ["a.ts"], chunkIndex: 1 })
    expect(out).toContain("DO NOT WRITE")
    expect(out).toContain("write_file")
    expect(out).toContain("edit_file")
  })

  it("requires reasoningChain with specific coverage points", () => {
    const out = buildReviewBlock({ filesToReview: ["a.ts"], chunkIndex: 1 })
    expect(out).toContain("`reasoningChain`")
    expect(out).toContain("COHERENT")
    expect(out).toContain("MISSING")
    expect(out).toContain("CONTRADICTIONS")
  })

  it("filters non-string and empty file entries", () => {
    const out = buildReviewBlock({
      filesToReview: ["valid.ts", "", null as unknown as string, "another.ts"],
      chunkIndex: 1,
    })
    // Both valid files render as file-bullets
    expect(out).toContain("- valid.ts")
    expect(out).toContain("- another.ts")
    // Specifically two file-bullet lines (filename-ending pattern, not
    // the generic `- ` bullets in the reasoningChain coverage list)
    const fileBullets = out.match(/^   - \S+\.\w+$/gm) ?? []
    expect(fileBullets).toHaveLength(2)
  })
})
