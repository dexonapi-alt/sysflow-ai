import { describe, it, expect, beforeEach } from "vitest"
import {
  recordChunkStart,
  attachExecutedFiles,
  attachReflection,
  getChunkHistory,
  chunkCount,
  getLatestChunk,
  clearChunkState,
  _resetForTests,
} from "../chunk-state.js"
import type { ChunkPlanBrief, ChunkReflectionBrief } from "../../reasoning/reasoning-schema.js"

const samplePlan = (over: Partial<ChunkPlanBrief> = {}): ChunkPlanBrief => ({
  nextAction: "write models",
  files: ["src/models/User.js"],
  rationale: "models before routes",
  dependencies: [],
  expectedSizeBin: "small",
  isFinalChunk: false,
  ...over,
})

const sampleReflection = (over: Partial<ChunkReflectionBrief> = {}): ChunkReflectionBrief => ({
  coherent: true,
  issues: [],
  nextFocus: "wire routes next",
  shouldStop: false,
  ...over,
})

describe("chunk-state", () => {
  beforeEach(() => _resetForTests())

  it("starts with no chunks for an unknown run", () => {
    expect(chunkCount("r-empty")).toBe(0)
    expect(getChunkHistory("r-empty")).toEqual([])
    expect(getLatestChunk("r-empty")).toBeNull()
  })

  it("records a chunk start and increments count", () => {
    const b = recordChunkStart("r1", samplePlan())
    expect(b.index).toBe(0)
    expect(b.reflection).toBeNull()
    expect(chunkCount("r1")).toBe(1)
  })

  it("indexes chunks sequentially per run", () => {
    recordChunkStart("r1", samplePlan({ nextAction: "first" }))
    recordChunkStart("r1", samplePlan({ nextAction: "second" }))
    recordChunkStart("r1", samplePlan({ nextAction: "third" }))
    const history = getChunkHistory("r1")
    expect(history.map((b) => b.index)).toEqual([0, 1, 2])
    expect(history.map((b) => b.plan.nextAction)).toEqual(["first", "second", "third"])
  })

  it("isolates chunk history by runId", () => {
    recordChunkStart("r1", samplePlan({ nextAction: "r1-only" }))
    recordChunkStart("r2", samplePlan({ nextAction: "r2-only" }))
    expect(chunkCount("r1")).toBe(1)
    expect(chunkCount("r2")).toBe(1)
    expect(getChunkHistory("r1")[0].plan.nextAction).toBe("r1-only")
    expect(getChunkHistory("r2")[0].plan.nextAction).toBe("r2-only")
  })

  it("attaches executed files to a chunk in place", () => {
    recordChunkStart("r1", samplePlan())
    attachExecutedFiles("r1", 0, ["src/models/User.js", "src/models/Product.js"])
    expect(getChunkHistory("r1")[0].executedFiles).toEqual(["src/models/User.js", "src/models/Product.js"])
  })

  it("attaches reflection to the matching chunk index", () => {
    recordChunkStart("r1", samplePlan())
    recordChunkStart("r1", samplePlan({ nextAction: "second" }))
    attachReflection("r1", 1, sampleReflection({ nextFocus: "go polish" }))
    expect(getChunkHistory("r1")[0].reflection).toBeNull()
    expect(getChunkHistory("r1")[1].reflection?.nextFocus).toBe("go polish")
  })

  it("attachReflection on unknown chunk index is a no-op", () => {
    recordChunkStart("r1", samplePlan())
    expect(() => attachReflection("r1", 99, sampleReflection())).not.toThrow()
    expect(getChunkHistory("r1")[0].reflection).toBeNull()
  })

  it("getLatestChunk returns the most recent boundary", () => {
    recordChunkStart("r1", samplePlan({ nextAction: "first" }))
    recordChunkStart("r1", samplePlan({ nextAction: "latest" }))
    expect(getLatestChunk("r1")?.plan.nextAction).toBe("latest")
  })

  it("clearChunkState wipes a single run", () => {
    recordChunkStart("r1", samplePlan())
    recordChunkStart("r2", samplePlan())
    clearChunkState("r1")
    expect(chunkCount("r1")).toBe(0)
    expect(chunkCount("r2")).toBe(1)
  })
})
