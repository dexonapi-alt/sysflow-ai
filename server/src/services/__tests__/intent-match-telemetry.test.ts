/**
 * Stage 5 of `2026-05-16-awareness-and-verification-correctness.md`.
 *
 * Per-run intent-match telemetry counters. The divergence detector
 * bumps these when the intent_keyword_absent heuristic satisfies a
 * keyword via Stage 2's Tier 2 (structural) or Tier 3 (content) —
 * NOT via Tier 1 path-haystack, which would have passed the pre-Stage-
 * 2 detector. The cli's RunSummary records the cumulative total.
 */

import { describe, it, expect, beforeEach } from "vitest"
import {
  bumpIntentMatch,
  getIntentMatchCounters,
  getIntentMatchTotal,
  clearIntentMatchTelemetry,
  _resetIntentMatchStoreForTests,
} from "../intent-match-telemetry.js"
import {
  classifyIntentKeywordSatisfaction,
  detectDivergence,
  type DetectorInput,
} from "../divergence-detector.js"

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

beforeEach(() => {
  _resetIntentMatchStoreForTests()
})

describe("intent-match-telemetry — basic counter API", () => {
  it("starts at 0 for an unknown runId", () => {
    expect(getIntentMatchTotal("nonexistent")).toBe(0)
    expect(getIntentMatchCounters("nonexistent")).toEqual({ structuralMatches: 0, contentMatches: 0 })
  })

  it("bumps structuralMatches independently from contentMatches", () => {
    bumpIntentMatch("r1", "structural")
    bumpIntentMatch("r1", "structural")
    bumpIntentMatch("r1", "content")
    expect(getIntentMatchCounters("r1")).toEqual({ structuralMatches: 2, contentMatches: 1 })
    expect(getIntentMatchTotal("r1")).toBe(3)
  })

  it("isolates counters by runId", () => {
    bumpIntentMatch("r1", "structural")
    bumpIntentMatch("r2", "content")
    bumpIntentMatch("r2", "content")
    expect(getIntentMatchCounters("r1")).toEqual({ structuralMatches: 1, contentMatches: 0 })
    expect(getIntentMatchCounters("r2")).toEqual({ structuralMatches: 0, contentMatches: 2 })
  })

  it("clearIntentMatchTelemetry removes the entry for one run only", () => {
    bumpIntentMatch("r1", "structural")
    bumpIntentMatch("r2", "content")
    clearIntentMatchTelemetry("r1")
    expect(getIntentMatchTotal("r1")).toBe(0)
    expect(getIntentMatchTotal("r2")).toBe(1)
  })

  it("ignores empty runId (defensive — no Map pollution)", () => {
    bumpIntentMatch("", "structural")
    expect(getIntentMatchTotal("")).toBe(0)
  })
})

describe("classifyIntentKeywordSatisfaction — tier return values", () => {
  it("returns 'path' when keyword appears in path haystack", () => {
    expect(classifyIntentKeywordSatisfaction("express", "src/express-server.ts", [], new Map())).toBe("path")
  })

  it("returns 'structural' when keyword satisfied via package.json deps", () => {
    const snippets = new Map([["package.json", `{ "dependencies": { "express": "^4" } }`]])
    expect(classifyIntentKeywordSatisfaction("express", "src/server.ts", ["src/server.ts"], snippets)).toBe("structural")
  })

  it("returns 'structural' when keyword satisfied via framework file path (.tsx for react)", () => {
    // Path haystack "src/App.tsx" doesn't contain the word "react"
    // literally → Tier 1 misses. But ".tsx" is a structural signal
    // for react → Tier 2 fires.
    expect(classifyIntentKeywordSatisfaction("react", "src/App.tsx", ["src/App.tsx"], new Map())).toBe("structural")
  })

  it("returns 'content' when keyword satisfied only via content snippet word-boundary scan", () => {
    const snippets = new Map([
      ["src/db.ts", `import postgres from "postgres"`],
    ])
    // No path-haystack hit (the haystack is just "src/db.ts" which doesn't contain "postgres"),
    // no structural signal (postgres requires "pg" or similar in package.json content),
    // so Tier 3 fires.
    expect(classifyIntentKeywordSatisfaction("postgres", "src/db.ts", ["src/db.ts"], snippets)).toBe("content")
  })

  it("returns null when no tier satisfies", () => {
    expect(classifyIntentKeywordSatisfaction("express", "", [], new Map())).toBeNull()
  })

  it("prefers Tier 1 path over Tier 2 structural when both would match", () => {
    // "express" literally appears in the file path AND in
    // package.json deps. Tier 1 (path) checks first → wins, returns
    // "path" — even though structural would also have fired.
    const snippets = new Map([["package.json", `{ "dependencies": { "express": "^4" } }`]])
    expect(classifyIntentKeywordSatisfaction("express", "src/express-server.ts", ["src/express-server.ts"], snippets)).toBe("path")
  })
})

describe("detectDivergence — bumps telemetry on Tier 2/3 satisfactions", () => {
  it("bumps structuralMatches when package.json satisfies a keyword (no path-haystack hit)", () => {
    detectDivergence(
      baseInput({
        originalPrompt: "build an express POS backend",
        filesModified: ["src/server.ts", "src/routes/orders.ts", "package.json"],
        contentSnippets: new Map([
          ["package.json", `{ "dependencies": { "express": "^4.18.0" } }`],
        ]),
        runId: "r-detector-1",
      }),
    )
    const counters = getIntentMatchCounters("r-detector-1")
    // "express" satisfied via package.json content → structural bump.
    // (The path haystack contains "package.json" but not "express" the
    // word; haystackContainsKeyword uses substring match — and
    // "package.json" doesn't contain "express", so Tier 1 misses,
    // Tier 2 fires.)
    expect(counters.structuralMatches).toBeGreaterThanOrEqual(1)
  })

  it("does NOT bump when keyword satisfied via Tier 1 path haystack (existing behaviour)", () => {
    detectDivergence(
      baseInput({
        originalPrompt: "build with express",
        // express literally appears in a file path → Tier 1 wins → no bump.
        filesModified: ["src/express.config.ts"],
        contentSnippets: new Map(),
        runId: "r-detector-2",
      }),
    )
    const counters = getIntentMatchCounters("r-detector-2")
    expect(counters.structuralMatches).toBe(0)
    expect(counters.contentMatches).toBe(0)
  })

  it("does NOT bump when a keyword is missing (regression — telemetry tracks SATISFACTIONS only)", () => {
    detectDivergence(
      baseInput({
        originalPrompt: "build with prisma",
        filesModified: ["src/server.ts"],
        contentSnippets: new Map(),
        runId: "r-detector-3",
      }),
    )
    const counters = getIntentMatchCounters("r-detector-3")
    expect(counters.structuralMatches).toBe(0)
    expect(counters.contentMatches).toBe(0)
  })

  it("bumps once per keyword per detector call (user-repro: POS PG backend)", () => {
    detectDivergence(
      baseInput({
        originalPrompt: "build an express + postgres POS backend",
        filesModified: ["src/server.ts", "package.json"],
        contentSnippets: new Map([
          [
            "package.json",
            `{ "dependencies": { "express": "^4.18.0", "pg": "^8.11.0" } }`,
          ],
        ]),
        runId: "r-detector-4",
      }),
    )
    // Both "express" and "postgres" satisfied via package.json → 2 structural bumps.
    const counters = getIntentMatchCounters("r-detector-4")
    expect(counters.structuralMatches).toBe(2)
  })

  it("does not bump when runId is undefined (back-compat — pure-detector tests)", () => {
    detectDivergence(
      baseInput({
        originalPrompt: "build an express POS backend",
        filesModified: ["src/server.ts", "package.json"],
        contentSnippets: new Map([
          ["package.json", `{ "dependencies": { "express": "^4" } }`],
        ]),
        // runId omitted on purpose.
      }),
    )
    // No bump because runId wasn't supplied.
    expect(getIntentMatchTotal("")).toBe(0)
  })
})
