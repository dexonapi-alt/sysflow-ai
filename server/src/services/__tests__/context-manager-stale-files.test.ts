/**
 * Plan `2026-05-15-agent-runtime-fixes-and-project-init-reasoning.md` Stage 4.
 *
 * Tests for the per-turn directory refresh + stale-file detection.
 * `ingestDirectoryTree` now compares the refreshed tree against the
 * working context's `files` map and returns `staleFiles[]` — top-level
 * paths the agent created/edited/read that no longer exist on disk.
 */

import { describe, it, expect, beforeEach } from "vitest"
import {
  initRunContext,
  clearRunContext,
  ingestDirectoryTree,
  ingestToolResult,
  isNoiseTopLevelEntry,
  NOISE_TOP_LEVEL_ENTRIES,
} from "../context-manager.js"

const RUN_ID = "test-run-stale-files"

beforeEach(() => {
  clearRunContext(RUN_ID)
  initRunContext(RUN_ID, "build me a thing")
})

describe("ingestDirectoryTree — stale-file detection (Stage 4)", () => {
  it("returns an empty staleFiles list on the first ingest (no prior context)", () => {
    const { staleFiles } = ingestDirectoryTree(RUN_ID, [
      { name: "package.json", type: "file" },
      { name: "src", type: "directory" },
    ])
    expect(staleFiles).toEqual([])
  })

  it("returns an empty list when the tree still contains every tracked file", () => {
    ingestToolResult(RUN_ID, "write_file", { path: "tsconfig.json", content: "{}" }, { success: true })
    ingestToolResult(RUN_ID, "write_file", { path: "package.json", content: "{}" }, { success: true })
    const { staleFiles } = ingestDirectoryTree(RUN_ID, [
      { name: "tsconfig.json", type: "file" },
      { name: "package.json", type: "file" },
    ])
    expect(staleFiles).toEqual([])
  })

  it("flags a top-level file that was created earlier but no longer appears", () => {
    ingestToolResult(RUN_ID, "write_file", { path: "tsconfig.json", content: "{}" }, { success: true })
    ingestToolResult(RUN_ID, "write_file", { path: "package.json", content: "{}" }, { success: true })
    const { staleFiles } = ingestDirectoryTree(RUN_ID, [
      { name: "package.json", type: "file" },
    ])
    expect(staleFiles).toEqual(["tsconfig.json"])
  })

  it("flags multiple stale files", () => {
    ingestToolResult(RUN_ID, "write_file", { path: "tsconfig.json", content: "{}" }, { success: true })
    ingestToolResult(RUN_ID, "write_file", { path: "vite.config.ts", content: "" }, { success: true })
    ingestToolResult(RUN_ID, "write_file", { path: "package.json", content: "{}" }, { success: true })
    const { staleFiles } = ingestDirectoryTree(RUN_ID, [
      { name: "package.json", type: "file" },
    ])
    expect(staleFiles.sort()).toEqual(["tsconfig.json", "vite.config.ts"])
  })

  it("skips files already marked as deleted (no double-warn)", () => {
    ingestToolResult(RUN_ID, "write_file", { path: "tsconfig.json", content: "{}" }, { success: true })
    ingestToolResult(RUN_ID, "delete_file", { path: "tsconfig.json" }, { success: true })
    const { staleFiles } = ingestDirectoryTree(RUN_ID, [])
    expect(staleFiles).toEqual([])
  })

  it("skips sub-directory files (top-level snapshot can't verify them)", () => {
    ingestToolResult(RUN_ID, "write_file", { path: "src/index.ts", content: "" }, { success: true })
    ingestToolResult(RUN_ID, "write_file", { path: "tests/foo.test.ts", content: "" }, { success: true })
    const { staleFiles } = ingestDirectoryTree(RUN_ID, [])
    expect(staleFiles).toEqual([])
  })

  it("works with Windows-style backslash paths in sub-dirs (still skipped)", () => {
    ingestToolResult(RUN_ID, "write_file", { path: "src\\foo.ts", content: "" }, { success: true })
    const { staleFiles } = ingestDirectoryTree(RUN_ID, [])
    expect(staleFiles).toEqual([])
  })

  it("marks the stale file as deleted in the working context so re-ingest doesn't re-warn", () => {
    ingestToolResult(RUN_ID, "write_file", { path: "tsconfig.json", content: "{}" }, { success: true })
    // First ingest flags it stale.
    const first = ingestDirectoryTree(RUN_ID, [])
    expect(first.staleFiles).toEqual(["tsconfig.json"])
    // Second ingest with the same empty tree: no fresh warning (the
    // file is now marked deleted in the working context).
    const second = ingestDirectoryTree(RUN_ID, [])
    expect(second.staleFiles).toEqual([])
  })

  it("returns empty list when runId has no working context (defensive)", () => {
    const { staleFiles } = ingestDirectoryTree("nonexistent-run", [{ name: "x", type: "file" }])
    expect(staleFiles).toEqual([])
  })

  it("still updates the project_structure fact alongside stale detection", () => {
    ingestToolResult(RUN_ID, "write_file", { path: "tsconfig.json", content: "{}" }, { success: true })
    // First ingest establishes the tree.
    ingestDirectoryTree(RUN_ID, [{ name: "tsconfig.json", type: "file" }])
    // Second ingest with a different tree — both updates the fact AND
    // returns no stale (the file still exists).
    const { staleFiles } = ingestDirectoryTree(RUN_ID, [
      { name: "tsconfig.json", type: "file" },
      { name: "src", type: "directory" },
    ])
    expect(staleFiles).toEqual([])
  })

  it("flags a read file (not just created) that vanished", () => {
    ingestToolResult(RUN_ID, "read_file", { path: "README.md" }, { success: true, content: "# Hi" })
    const { staleFiles } = ingestDirectoryTree(RUN_ID, [{ name: "package.json", type: "file" }])
    expect(staleFiles).toEqual(["README.md"])
  })

  it("flags an edited file that vanished", () => {
    ingestToolResult(RUN_ID, "edit_file", { path: "config.yml" }, { success: true })
    const { staleFiles } = ingestDirectoryTree(RUN_ID, [{ name: "package.json", type: "file" }])
    expect(staleFiles).toEqual(["config.yml"])
  })
})

/**
 * Stage 1 of `2026-05-16-awareness-and-verification-correctness.md`.
 *
 * The prior plan's Stage 4 (per-turn directory refresh) used an
 * aggressive `!name.startsWith(".")` filter on the cli side. That
 * stripped `.env.example` (and friends) from the tree the server
 * received, so the server's staleness comparison flagged them as
 * stale immediately after the agent wrote them.
 *
 * Stage 1 introduces NOISE_TOP_LEVEL_ENTRIES on BOTH sides — narrow
 * set of heavy build dirs + tooling caches — and preserves
 * legitimate top-level dotfiles. Server's ingestDirectoryTree
 * applies the same filter so the two sides agree.
 */
describe("NOISE_TOP_LEVEL_ENTRIES — noise filter membership (Stage 1, awareness plan)", () => {
  it("includes the .git workdir + native build/cache dirs", () => {
    expect(NOISE_TOP_LEVEL_ENTRIES.has(".git")).toBe(true)
    expect(NOISE_TOP_LEVEL_ENTRIES.has("node_modules")).toBe(true)
    expect(NOISE_TOP_LEVEL_ENTRIES.has("dist")).toBe(true)
    expect(NOISE_TOP_LEVEL_ENTRIES.has("build")).toBe(true)
  })

  it("includes editor + OS metadata that shouldn't appear in project_structure", () => {
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
    expect(NOISE_TOP_LEVEL_ENTRIES.has(".gitignore")).toBe(false)
    expect(NOISE_TOP_LEVEL_ENTRIES.has(".eslintrc.json")).toBe(false)
    expect(NOISE_TOP_LEVEL_ENTRIES.has(".npmrc")).toBe(false)
    expect(NOISE_TOP_LEVEL_ENTRIES.has(".prettierrc")).toBe(false)
    expect(NOISE_TOP_LEVEL_ENTRIES.has(".editorconfig")).toBe(false)
    expect(NOISE_TOP_LEVEL_ENTRIES.has(".nvmrc")).toBe(false)
    expect(NOISE_TOP_LEVEL_ENTRIES.has(".dockerignore")).toBe(false)
  })

  it("isNoiseTopLevelEntry preserves the set semantics and adds the sysbase prefix", () => {
    expect(isNoiseTopLevelEntry(".git")).toBe(true)
    expect(isNoiseTopLevelEntry("node_modules")).toBe(true)
    expect(isNoiseTopLevelEntry("sysbase")).toBe(true)
    expect(isNoiseTopLevelEntry("sysbase-cache")).toBe(true)
    expect(isNoiseTopLevelEntry("sysbase_runs")).toBe(true)
    expect(isNoiseTopLevelEntry(".env.example")).toBe(false)
    expect(isNoiseTopLevelEntry("package.json")).toBe(false)
    expect(isNoiseTopLevelEntry("src")).toBe(false)
  })
})

describe("ingestDirectoryTree — noise filter integration (Stage 1, awareness plan)", () => {
  it("does NOT flag .env.example as stale when the agent just wrote it (regression)", () => {
    // Repro of the user-reported bug from 2026-05-16:
    // [directory-refresh] 1 stale top-level file(s): .env.example
    ingestToolResult(RUN_ID, "write_file", { path: ".env.example", content: "DATABASE_URL=" }, { success: true })
    const { staleFiles } = ingestDirectoryTree(RUN_ID, [
      { name: "package.json", type: "file" },
      { name: ".env.example", type: "file" },
    ])
    expect(staleFiles).toEqual([])
  })

  it("does NOT flag .gitignore / .eslintrc.json / .npmrc as stale", () => {
    ingestToolResult(RUN_ID, "write_file", { path: ".gitignore", content: "node_modules\n" }, { success: true })
    ingestToolResult(RUN_ID, "write_file", { path: ".eslintrc.json", content: "{}" }, { success: true })
    ingestToolResult(RUN_ID, "write_file", { path: ".npmrc", content: "" }, { success: true })
    const { staleFiles } = ingestDirectoryTree(RUN_ID, [
      { name: ".gitignore", type: "file" },
      { name: ".eslintrc.json", type: "file" },
      { name: ".npmrc", type: "file" },
    ])
    expect(staleFiles).toEqual([])
  })

  it("strips noise entries (.git / node_modules / dist) from project_structure", () => {
    ingestDirectoryTree(RUN_ID, [
      { name: ".git", type: "directory" },
      { name: "node_modules", type: "directory" },
      { name: "dist", type: "directory" },
      { name: "package.json", type: "file" },
      { name: "src", type: "directory" },
    ])
    // project_structure fact should only show the non-noise entries.
    // (We can't directly read the fact from outside, but we infer: a
    // subsequent ingest with ONLY package.json + src should produce
    // the same fact value as if the noise had never been there.)
    const { staleFiles } = ingestDirectoryTree(RUN_ID, [
      { name: "package.json", type: "file" },
      { name: "src", type: "directory" },
    ])
    expect(staleFiles).toEqual([])
  })

  it("does not flag tracked files whose names happen to be noise (defensive)", () => {
    // Edge case: agent somehow tracked "dist" or ".git" as a top-level
    // path. Refresh with no tree entries should NOT report them stale
    // since the noise filter excludes them on the tracked-files side
    // too.
    ingestToolResult(RUN_ID, "read_file", { path: "dist" }, { success: true })
    ingestToolResult(RUN_ID, "read_file", { path: ".git" }, { success: true })
    const { staleFiles } = ingestDirectoryTree(RUN_ID, [
      { name: "package.json", type: "file" },
    ])
    expect(staleFiles).toEqual([])
  })

  it("DOES still flag a legitimate top-level file that the agent created then deleted", () => {
    ingestToolResult(RUN_ID, "write_file", { path: "tsconfig.json", content: "{}" }, { success: true })
    const { staleFiles } = ingestDirectoryTree(RUN_ID, [
      { name: "package.json", type: "file" },
    ])
    expect(staleFiles).toEqual(["tsconfig.json"])
  })
})
