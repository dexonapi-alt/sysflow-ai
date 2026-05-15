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
