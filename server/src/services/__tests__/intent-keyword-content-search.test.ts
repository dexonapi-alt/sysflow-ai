/**
 * Stage 2 of `2026-05-16-awareness-and-verification-correctness.md`.
 *
 * `intent_keyword_absent` heuristic now searches:
 *   1. File paths + completion message (existing path-haystack)
 *   2. STRUCTURAL signals — package.json deps + framework-specific files
 *   3. Content snippets — first 1KB of every newly-written file
 *
 * Before this fix the heuristic fired on a legitimately-built
 * Express + PostgreSQL POS backend because "express" / "postgres"
 * never appeared in file PATHS, only in `package.json` deps and in
 * the import statements of `src/config/db.ts`.
 */

import { describe, it, expect } from "vitest"
import {
  detectDivergence,
  isIntentKeywordSatisfied,
  type DetectorInput,
} from "../divergence-detector.js"
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
  originalPrompt: "do something",
  chunkHistory: [baseChunk()],
  filesModified: [],
  toolErrorCounts: new Map(),
  createdDirs: [],
  completionMessage: null,
  plannedChunkCount: null,
  ...over,
})

describe("isIntentKeywordSatisfied — three-tier satisfaction", () => {
  describe("Tier 1 — path haystack (existing behaviour)", () => {
    it("satisfies when keyword appears in a file path", () => {
      expect(isIntentKeywordSatisfied("express", "src/express-server.ts", [], new Map())).toBe(true)
    })

    it("satisfies when keyword appears in the completion message", () => {
      expect(isIntentKeywordSatisfied("react", "completed: built a react app", [], new Map())).toBe(true)
    })

    it("does NOT satisfy when path haystack is empty", () => {
      expect(isIntentKeywordSatisfied("express", "", [], new Map())).toBe(false)
    })
  })

  describe("Tier 2 — structural signals (the regression fix)", () => {
    it("satisfies 'express' when package.json content includes the dep (user-reported repro)", () => {
      const snippets = new Map([
        ["package.json", `{\n  "dependencies": {\n    "express": "^4.18.0",\n    "pg": "^8.11.0"\n  }\n}`],
      ])
      expect(isIntentKeywordSatisfied("express", "src/server.ts", ["src/server.ts"], snippets)).toBe(true)
    })

    it("satisfies 'postgres' / 'postgresql' / 'pg' all when package.json has \"pg\"", () => {
      const snippets = new Map([
        ["package.json", `{ "dependencies": { "pg": "^8.11.0" } }`],
      ])
      const files = ["src/db.ts"]
      const haystack = files.join(" ")
      expect(isIntentKeywordSatisfied("postgres", haystack, files, snippets)).toBe(true)
      expect(isIntentKeywordSatisfied("postgresql", haystack, files, snippets)).toBe(true)
      expect(isIntentKeywordSatisfied("pg", haystack, files, snippets)).toBe(true)
    })

    it("satisfies 'prisma' when prisma/schema.prisma exists in tracked paths", () => {
      const snippets = new Map([["prisma/schema.prisma", "datasource db { provider = \"postgresql\" }"]])
      expect(isIntentKeywordSatisfied("prisma", "prisma/schema.prisma", ["prisma/schema.prisma"], snippets)).toBe(true)
    })

    it("satisfies 'react' when package.json has react OR a .tsx file exists", () => {
      // Via package.json
      expect(
        isIntentKeywordSatisfied(
          "react",
          "src/App.tsx",
          [],
          new Map([["package.json", `{ "dependencies": { "react": "^18.2.0" } }`]]),
        ),
      ).toBe(true)
      // Via .tsx file path (even without package.json snippet)
      expect(
        isIntentKeywordSatisfied("react", "src/App.tsx", ["src/App.tsx"], new Map()),
      ).toBe(true)
    })

    it("satisfies 'tailwind' when package.json has tailwindcss OR tailwind.config exists", () => {
      expect(
        isIntentKeywordSatisfied(
          "tailwind",
          "src/styles.css",
          [],
          new Map([["package.json", `{ "devDependencies": { "tailwindcss": "^3.4.0" } }`]]),
        ),
      ).toBe(true)
      expect(
        isIntentKeywordSatisfied("tailwind", "tailwind.config.js", ["tailwind.config.js"], new Map()),
      ).toBe(true)
    })

    it("satisfies 'typescript' when tsconfig.json exists in tracked paths", () => {
      expect(
        isIntentKeywordSatisfied("typescript", "tsconfig.json src/index.ts", ["tsconfig.json", "src/index.ts"], new Map()),
      ).toBe(true)
    })

    it("does NOT satisfy 'express' when package.json doesn't include the dep", () => {
      const snippets = new Map([
        ["package.json", `{ "dependencies": { "fastify": "^4.0.0" } }`],
      ])
      expect(isIntentKeywordSatisfied("express", "src/server.ts", ["src/server.ts"], snippets)).toBe(false)
    })
  })

  describe("Tier 3 — content snippet word-boundary scan", () => {
    it("satisfies when keyword appears as a standalone word in any content snippet", () => {
      const snippets = new Map([
        ["src/db.ts", `import postgres from "postgres"\nexport const db = postgres(env.DATABASE_URL)`],
      ])
      expect(isIntentKeywordSatisfied("postgres", "src/db.ts", ["src/db.ts"], snippets)).toBe(true)
    })

    it("does NOT false-satisfy 'react' on 'reactor' (word-boundary regex)", () => {
      // The content has "reactor" but not "react" — must NOT satisfy
      // the "react" keyword. Pre-Stage-2 substring match would have
      // false-flagged this.
      const snippets = new Map([
        ["src/engine.ts", `class NuclearReactor { ignite() {} }`],
      ])
      expect(isIntentKeywordSatisfied("react", "src/engine.ts", ["src/engine.ts"], snippets)).toBe(false)
    })

    it("does NOT false-satisfy 'pg' on 'package' (word-boundary)", () => {
      // Tricky one: 'pg' is a short keyword; substring would match
      // "package.json" and "upgrade" — the structural signal lookup
      // for 'pg' falls through to Tier 3, which uses a word-boundary
      // regex. The dummy snippet below mentions 'package' but not 'pg'.
      const snippets = new Map([
        ["README.md", "Run `npm install` to set up the package."],
      ])
      // Path haystack also doesn't contain 'pg' as a word.
      expect(isIntentKeywordSatisfied("pg", "readme.md", ["README.md"], snippets)).toBe(false)
    })
  })

  describe("composition + edge cases", () => {
    it("returns false for an unknown keyword when no haystack / snippet matches", () => {
      expect(isIntentKeywordSatisfied("madeup-framework", "", [], new Map())).toBe(false)
    })

    it("structural signals win over content scan (faster path)", () => {
      // package.json has "express" → Tier 2 fires; doesn't even need Tier 3.
      const snippets = new Map([
        ["package.json", `{ "dependencies": { "express": "^4.18.0" } }`],
      ])
      expect(isIntentKeywordSatisfied("express", "", [], snippets)).toBe(true)
    })

    it("handles Windows-style backslash paths in prisma signal check", () => {
      // The signal table includes both 'prisma/schema.prisma' (Unix)
      // and 'prisma\\schema.prisma' (Windows) variants.
      const winFiles = ["prisma\\schema.prisma"]
      expect(isIntentKeywordSatisfied("prisma", winFiles.join(" "), winFiles, new Map())).toBe(true)
    })

    it("recognises package.json content at a non-root path (e.g. monorepo)", () => {
      const snippets = new Map([
        ["packages/api/package.json", `{ "dependencies": { "express": "^4" } }`],
      ])
      expect(isIntentKeywordSatisfied("express", "", [], snippets)).toBe(true)
    })
  })
})

describe("detectDivergence — intent_keyword_absent regression (Stage 2)", () => {
  it("does NOT flag 'express' as absent when package.json content has the dep (user-reported POS PG repro)", () => {
    // The user's repro: agent built an Express + PostgreSQL POS
    // backend. Pre-Stage-2 the heuristic flagged "express" + "postgres"
    // as absent because they only appeared in package.json + import
    // statements — not in file PATHS.
    const out = detectDivergence(
      baseInput({
        originalPrompt: "build an express + postgres POS backend",
        filesModified: ["src/server.ts", "src/routes/orders.ts", "src/db.ts", "package.json"],
        contentSnippets: new Map([
          [
            "package.json",
            `{\n  "dependencies": {\n    "express": "^4.18.0",\n    "pg": "^8.11.0"\n  }\n}`,
          ],
          ["src/db.ts", `import { Pool } from "pg"\nexport const db = new Pool({ connectionString: process.env.DATABASE_URL })`],
        ]),
      }),
    )
    const hits = out.filter((s) => s.category === "intent_keyword_absent")
    expect(hits).toEqual([])
  })

  it("STILL flags a genuinely missing keyword (regression — heuristic isn't disarmed)", () => {
    // User asked for express + prisma, agent built express + raw pg
    // (no prisma anywhere). The heuristic should still fire for
    // 'prisma'.
    const out = detectDivergence(
      baseInput({
        originalPrompt: "build an express + prisma app",
        filesModified: ["src/server.ts", "package.json"],
        contentSnippets: new Map([
          ["package.json", `{ "dependencies": { "express": "^4", "pg": "^8" } }`],
        ]),
      }),
    )
    const hits = out.filter((s) => s.category === "intent_keyword_absent")
    expect(hits).toHaveLength(1)
    expect(hits[0].detail).toContain("prisma")
    expect(hits[0].detail).not.toContain("express")
  })

  it("falls back to path-only haystack when contentSnippets is undefined (backwards compatible)", () => {
    // Legacy caller without contentSnippets — Stage 2 should not
    // regress the path-only haystack path. "express" must satisfy
    // via the file path the way it did pre-Stage-2.
    const out = detectDivergence(
      baseInput({
        originalPrompt: "build with express",
        filesModified: ["src/express.config.ts"],
        // contentSnippets explicitly omitted — undefined / legacy.
      }),
    )
    const hits = out.filter((s) => s.category === "intent_keyword_absent")
    expect(hits).toEqual([])
  })

  it("does NOT flag intent_keyword_absent on a clean React run with package.json", () => {
    const out = detectDivergence(
      baseInput({
        originalPrompt: "build a react app with tailwind",
        filesModified: ["src/App.tsx", "src/styles.css", "package.json", "tailwind.config.js"],
        contentSnippets: new Map([
          ["package.json", `{ "dependencies": { "react": "^18", "tailwindcss": "^3" } }`],
          ["tailwind.config.js", `module.exports = { content: ["./src/**/*.{ts,tsx}"] }`],
        ]),
      }),
    )
    const hits = out.filter((s) => s.category === "intent_keyword_absent")
    expect(hits).toEqual([])
  })
})
