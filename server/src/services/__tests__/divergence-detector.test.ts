import { describe, it, expect } from "vitest"
import { detectDivergence, extractIntentKeywords, extractFilePathsFromMessage, pickDivergenceAnchor, type DetectorInput } from "../divergence-detector.js"
import type { ChunkBoundary } from "../chunk-state.js"
import type { ChunkPlanBrief } from "../../reasoning/reasoning-schema.js"

const baseChunk = (over: Partial<ChunkBoundary> = {}): ChunkBoundary => ({
  index: 0,
  startedAt: 0,
  plan: {
    nextAction: "noop",
    files: [],
    rationale: "",
    dependencies: [],
    expectedSizeBin: "small",
    isFinalChunk: false,
  } as ChunkPlanBrief,
  executedFiles: [],
  reflection: null,
  ...over,
})

const baseInput = (over: Partial<DetectorInput> = {}): DetectorInput => ({
  originalPrompt: "do something simple",
  chunkHistory: [],
  filesModified: [],
  toolErrorCounts: new Map(),
  createdDirs: [],
  completionMessage: null,
  plannedChunkCount: null,
  ...over,
})

describe("divergence-detector", () => {
  it("returns no signals on a healthy run", () => {
    const out = detectDivergence(baseInput({
      filesModified: ["src/index.ts", "src/util.ts"],
      chunkHistory: [baseChunk()],
    }))
    expect(out).toEqual([])
  })

  it("flags a file edited more than the threshold", () => {
    // SAME_FILE_EDIT_THRESHOLD is 3 → need >3 occurrences to fire (i.e. 4+)
    const out = detectDivergence(baseInput({
      filesModified: ["src/looped.ts", "src/looped.ts", "src/looped.ts", "src/looped.ts"],
    }))
    const hits = out.filter((s) => s.category === "same_file_edited_repeatedly")
    expect(hits).toHaveLength(1)
    expect(hits[0].detail).toContain("src/looped.ts")
  })

  it("flags a repeated tool error class", () => {
    // TOOL_ERROR_REPEAT_THRESHOLD is 2 → need >2 occurrences (i.e. 3+)
    const out = detectDivergence(baseInput({
      toolErrorCounts: new Map([["edit_file", 3]]),
    }))
    const hits = out.filter((s) => s.category === "repeated_tool_error")
    expect(hits).toHaveLength(1)
    expect(hits[0].detail).toContain("edit_file")
  })

  it("flags a created directory that has no files written into it", () => {
    const out = detectDivergence(baseInput({
      createdDirs: ["src/empty-dir"],
      filesModified: ["src/other/index.ts"], // none under src/empty-dir
    }))
    const hits = out.filter((s) => s.category === "mkdir_empty_at_chunk_boundary")
    expect(hits).toHaveLength(1)
    expect(hits[0].detail).toContain("src/empty-dir")
  })

  it("does not flag an empty-dir signal when the dir got populated", () => {
    const out = detectDivergence(baseInput({
      createdDirs: ["src/used-dir"],
      filesModified: ["src/used-dir/file.ts"],
    }))
    expect(out.find((s) => s.category === "mkdir_empty_at_chunk_boundary")).toBeUndefined()
  })

  it("flags intent_keyword_absent when the user asked for postgres but no implementation mentions it", () => {
    const out = detectDivergence(baseInput({
      originalPrompt: "build a Postgres-backed user API",
      filesModified: ["src/models/user.ts", "src/routes/user.ts"],
    }))
    const hits = out.filter((s) => s.category === "intent_keyword_absent")
    expect(hits).toHaveLength(1)
    expect(hits[0].detail).toContain("postgres")
  })

  it("does NOT flag intent_keyword_absent when the keyword appears in a filename", () => {
    const out = detectDivergence(baseInput({
      originalPrompt: "build a postgres-backed user API",
      filesModified: ["src/db/postgres-pool.ts"],
    }))
    expect(out.find((s) => s.category === "intent_keyword_absent")).toBeUndefined()
  })

  it("does NOT flag intent_keyword_absent on prompts with no whitelisted keywords", () => {
    const out = detectDivergence(baseInput({
      originalPrompt: "add a logout endpoint",
      filesModified: ["src/auth/logout.ts"],
    }))
    expect(out.find((s) => s.category === "intent_keyword_absent")).toBeUndefined()
  })

  it("flags scope_creep when chunk count overshoots the planned count", () => {
    // SCOPE_CREEP_RATIO is 1.5 → planned 4, ceil(4*1.5)=6, need >6 chunks i.e. 7+
    const out = detectDivergence(baseInput({
      plannedChunkCount: 4,
      chunkHistory: Array.from({ length: 7 }, (_, i) => baseChunk({ index: i })),
    }))
    const hits = out.filter((s) => s.category === "scope_creep")
    expect(hits).toHaveLength(1)
  })

  it("does not flag scope_creep without a plan", () => {
    const out = detectDivergence(baseInput({
      plannedChunkCount: null,
      chunkHistory: Array.from({ length: 20 }, (_, i) => baseChunk({ index: i })),
    }))
    expect(out.find((s) => s.category === "scope_creep")).toBeUndefined()
  })

  it("flags completion_claims_unwritten_files when the message names files not on disk", () => {
    const out = detectDivergence(baseInput({
      filesModified: ["src/index.ts"],
      completionMessage: "Done — created src/controllers/user.ts and src/routes/user.ts as requested.",
    }))
    const hits = out.filter((s) => s.category === "completion_claims_unwritten_files")
    expect(hits).toHaveLength(1)
    expect(hits[0].detail).toMatch(/controllers|routes/)
  })

  it("does not flag claims-unwritten when every named file appears in filesModified", () => {
    const out = detectDivergence(baseInput({
      filesModified: ["src/controllers/user.ts", "src/routes/user.ts"],
      completionMessage: "Done — wrote src/controllers/user.ts and src/routes/user.ts.",
    }))
    expect(out.find((s) => s.category === "completion_claims_unwritten_files")).toBeUndefined()
  })
})

describe("extractIntentKeywords", () => {
  it("returns whitelisted tech keywords from a prompt", () => {
    const got = extractIntentKeywords("Build a React + Postgres app with TypeScript please")
    // Set order isn't guaranteed; assert membership.
    expect(got).toEqual(expect.arrayContaining(["react", "postgres", "typescript"]))
  })

  it("ignores non-vocab words", () => {
    const got = extractIntentKeywords("just add a small feature please")
    expect(got).toEqual([])
  })

  it("dedupes repeated keywords", () => {
    const got = extractIntentKeywords("react react react!")
    expect(got).toEqual(["react"])
  })

  it("handles empty input", () => {
    expect(extractIntentKeywords("")).toEqual([])
  })
})

describe("extractFilePathsFromMessage", () => {
  it("pulls path-like tokens with extensions", () => {
    const got = extractFilePathsFromMessage("Wrote src/index.ts and lib/util.js")
    expect(got).toEqual(expect.arrayContaining(["src/index.ts", "lib/util.js"]))
  })

  it("rejects version-number-shaped junk", () => {
    const got = extractFilePathsFromMessage("Updated to v1.5 and 2.0 release")
    expect(got).toEqual([])
  })

  it("returns [] on empty input", () => {
    expect(extractFilePathsFromMessage("")).toEqual([])
  })
})

// ─── Phase 15 Stage 5: original-intent reader anchor selection ───

describe("pickDivergenceAnchor — original_intent reader for divergence", () => {
  it("returns the current prompt verbatim when it's substantive (≥ 30 chars)", () => {
    const current = "Build a postgres-backed user API with auth"
    expect(pickDivergenceAnchor(current, [])).toBe(current)
    // Even when original_intent entries exist, a substantive current prompt wins.
    expect(pickDivergenceAnchor(current, ["a much longer historical prompt with details about something else entirely"])).toBe(current)
  })

  it("falls back to the longest original_intent when current prompt is short", () => {
    // /continue, fix it, etc.
    const got = pickDivergenceAnchor("continue", [
      "build a small thing",
      "build a postgres-backed user API with auth, sessions, and audit log",
      "fix typo",
    ])
    expect(got).toBe("build a postgres-backed user API with auth, sessions, and audit log")
  })

  it("returns trimmed current prompt when no substantive original_intent is on file", () => {
    expect(pickDivergenceAnchor("continue", [])).toBe("continue")
    expect(pickDivergenceAnchor("continue", ["fix it", "go on"])).toBe("continue")
  })

  it("trims whitespace on both inputs", () => {
    expect(pickDivergenceAnchor("   continue   ", [])).toBe("continue")
    expect(pickDivergenceAnchor("  ", ["  build a postgres-backed user API with auth  "])).toBe("build a postgres-backed user API with auth")
  })

  it("ignores non-string entries in the candidates list defensively", () => {
    const got = pickDivergenceAnchor("/continue", [
      // @ts-expect-error — intentional bad input to assert the runtime guard
      null,
      "build a postgres-backed user API with all the trimmings",
      // @ts-expect-error — intentional bad input
      42,
    ])
    expect(got).toBe("build a postgres-backed user API with all the trimmings")
  })

  it("never returns null/undefined — always a string", () => {
    expect(typeof pickDivergenceAnchor("", [])).toBe("string")
    expect(typeof pickDivergenceAnchor("", ["only short"])).toBe("string")
  })

  it("the 30-char threshold is exclusive — exactly 29 chars falls back, 30 chars wins", () => {
    const at29 = "x".repeat(29)
    const at30 = "x".repeat(30)
    const longHist = "build a postgres-backed user API"
    // 29 → falls back to the longer original_intent
    expect(pickDivergenceAnchor(at29, [longHist])).toBe(longHist)
    // 30 → wins
    expect(pickDivergenceAnchor(at30, [longHist])).toBe(at30)
  })
})
