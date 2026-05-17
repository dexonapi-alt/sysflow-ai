/**
 * Stage 1 of `2026-05-16-awareness-and-verification-correctness.md`.
 *
 * Pure tests for the noise filter used by `captureTopLevelTree`.
 * The function itself reads from disk so we test the pure predicate
 * `isNoiseTopLevelEntry` + the underlying NOISE_TOP_LEVEL_ENTRIES set.
 *
 * The cli-side filter MUST stay in sync with the server-side filter
 * in server/src/services/context-manager.ts. The mirroring test
 * `context-manager-stale-files.test.ts` covers the server side; the
 * suite below covers the cli side.
 */

import { describe, it, expect } from "vitest"
import {
  isNoiseTopLevelEntry,
  NOISE_TOP_LEVEL_ENTRIES,
} from "../executor.js"

describe("NOISE_TOP_LEVEL_ENTRIES — cli filter membership", () => {
  it("includes the .git workdir + native build/cache dirs", () => {
    expect(NOISE_TOP_LEVEL_ENTRIES.has(".git")).toBe(true)
    expect(NOISE_TOP_LEVEL_ENTRIES.has("node_modules")).toBe(true)
    expect(NOISE_TOP_LEVEL_ENTRIES.has("dist")).toBe(true)
    expect(NOISE_TOP_LEVEL_ENTRIES.has("build")).toBe(true)
  })

  it("includes editor + OS metadata that bloats the snapshot", () => {
    expect(NOISE_TOP_LEVEL_ENTRIES.has(".DS_Store")).toBe(true)
    expect(NOISE_TOP_LEVEL_ENTRIES.has(".vscode")).toBe(true)
    expect(NOISE_TOP_LEVEL_ENTRIES.has(".idea")).toBe(true)
  })

  it("includes Python + framework caches the agent never authors", () => {
    expect(NOISE_TOP_LEVEL_ENTRIES.has("__pycache__")).toBe(true)
    expect(NOISE_TOP_LEVEL_ENTRIES.has(".pytest_cache")).toBe(true)
    expect(NOISE_TOP_LEVEL_ENTRIES.has(".mypy_cache")).toBe(true)
    expect(NOISE_TOP_LEVEL_ENTRIES.has(".next")).toBe(true)
    expect(NOISE_TOP_LEVEL_ENTRIES.has(".nuxt")).toBe(true)
    expect(NOISE_TOP_LEVEL_ENTRIES.has(".turbo")).toBe(true)
    expect(NOISE_TOP_LEVEL_ENTRIES.has(".cache")).toBe(true)
  })

  it("EXCLUDES legitimate top-level dotfiles the agent commonly authors", () => {
    expect(NOISE_TOP_LEVEL_ENTRIES.has(".env")).toBe(false)
    expect(NOISE_TOP_LEVEL_ENTRIES.has(".env.example")).toBe(false)
    expect(NOISE_TOP_LEVEL_ENTRIES.has(".env.local")).toBe(false)
    expect(NOISE_TOP_LEVEL_ENTRIES.has(".env.production")).toBe(false)
    expect(NOISE_TOP_LEVEL_ENTRIES.has(".gitignore")).toBe(false)
    expect(NOISE_TOP_LEVEL_ENTRIES.has(".eslintrc.json")).toBe(false)
    expect(NOISE_TOP_LEVEL_ENTRIES.has(".eslintrc.js")).toBe(false)
    expect(NOISE_TOP_LEVEL_ENTRIES.has(".npmrc")).toBe(false)
    expect(NOISE_TOP_LEVEL_ENTRIES.has(".prettierrc")).toBe(false)
    expect(NOISE_TOP_LEVEL_ENTRIES.has(".editorconfig")).toBe(false)
    expect(NOISE_TOP_LEVEL_ENTRIES.has(".nvmrc")).toBe(false)
    expect(NOISE_TOP_LEVEL_ENTRIES.has(".dockerignore")).toBe(false)
  })
})

describe("isNoiseTopLevelEntry — predicate semantics", () => {
  it("returns true for every NOISE_TOP_LEVEL_ENTRIES member", () => {
    for (const entry of NOISE_TOP_LEVEL_ENTRIES) {
      expect(isNoiseTopLevelEntry(entry)).toBe(true)
    }
  })

  it("returns true for any name starting with the sysbase prefix", () => {
    expect(isNoiseTopLevelEntry("sysbase")).toBe(true)
    expect(isNoiseTopLevelEntry("sysbase-cache")).toBe(true)
    expect(isNoiseTopLevelEntry("sysbase_runs")).toBe(true)
    expect(isNoiseTopLevelEntry("sysbase.json")).toBe(true)
  })

  it("returns false for legitimate project files", () => {
    expect(isNoiseTopLevelEntry("package.json")).toBe(false)
    expect(isNoiseTopLevelEntry("tsconfig.json")).toBe(false)
    expect(isNoiseTopLevelEntry("README.md")).toBe(false)
    expect(isNoiseTopLevelEntry("src")).toBe(false)
    expect(isNoiseTopLevelEntry("tests")).toBe(false)
    expect(isNoiseTopLevelEntry("prisma")).toBe(false)
  })

  it("returns false for legitimate top-level dotfiles (regression — .env.example bug)", () => {
    expect(isNoiseTopLevelEntry(".env")).toBe(false)
    expect(isNoiseTopLevelEntry(".env.example")).toBe(false)
    expect(isNoiseTopLevelEntry(".gitignore")).toBe(false)
    expect(isNoiseTopLevelEntry(".npmrc")).toBe(false)
  })

  it("is case-sensitive (matches the underlying Set semantics)", () => {
    // .GIT / .Git / NODE_MODULES are NOT in the noise set — case
    // matters. This is intentional: real-world tooling uses the
    // lowercase canonical names; anything else is the agent's own
    // file and we should keep it visible.
    expect(isNoiseTopLevelEntry(".GIT")).toBe(false)
    expect(isNoiseTopLevelEntry("NODE_MODULES")).toBe(false)
    expect(isNoiseTopLevelEntry("DIST")).toBe(false)
  })

  it("does not strip the literal string 'sysbase-like' beyond the prefix rule (defensive)", () => {
    // Bare prefix match only — substring match would over-strip.
    expect(isNoiseTopLevelEntry("my-sysbase")).toBe(false)
    expect(isNoiseTopLevelEntry("packages-sysbase")).toBe(false)
  })
})

describe("cli/server filter parity", () => {
  it("the cli's NOISE_TOP_LEVEL_ENTRIES has the same entries as the server's (literal sync check)", () => {
    // If either side drifts, the staleness comparison desyncs and we
    // get false positives again. This list MUST match
    // server/src/services/context-manager.ts NOISE_TOP_LEVEL_ENTRIES.
    const expected = [
      ".git",
      ".DS_Store",
      ".vscode",
      ".idea",
      "node_modules",
      "__pycache__",
      ".pytest_cache",
      ".mypy_cache",
      ".next",
      ".nuxt",
      "dist",
      "build",
      ".turbo",
      ".cache",
    ]
    expect([...NOISE_TOP_LEVEL_ENTRIES].sort()).toEqual(expected.sort())
  })
})
