/**
 * Stage 2 of `2026-05-16-awareness-and-verification-correctness.md`.
 *
 * Context-manager's `contentSnippets` index — captured on write_file /
 * edit_file / batch_write ingest, bounded to 1KB per file + 60 files
 * per run, and surfaced via `getContentSnippets(runId)`.
 */

import { describe, it, expect, beforeEach } from "vitest"
import {
  initRunContext,
  clearRunContext,
  ingestToolResult,
  getContentSnippets,
} from "../context-manager.js"

const RUN_ID = "test-run-content-snippets"

beforeEach(() => {
  clearRunContext(RUN_ID)
  initRunContext(RUN_ID, "build the thing")
})

describe("getContentSnippets — basic capture", () => {
  it("returns an empty Map for a run with no writes", () => {
    expect(getContentSnippets(RUN_ID).size).toBe(0)
  })

  it("returns an empty Map for an unknown runId", () => {
    expect(getContentSnippets("nonexistent").size).toBe(0)
  })

  it("captures content from a successful write_file", () => {
    ingestToolResult(
      RUN_ID,
      "write_file",
      { path: "package.json", content: `{ "dependencies": { "express": "^4" } }` },
      { success: true },
    )
    const snippets = getContentSnippets(RUN_ID)
    expect(snippets.size).toBe(1)
    expect(snippets.get("package.json")).toContain("express")
  })

  it("does NOT capture content from a FAILED write_file", () => {
    ingestToolResult(
      RUN_ID,
      "write_file",
      { path: "package.json", content: `{ "dependencies": { "express": "^4" } }` },
      { success: false, error: "permission denied" },
    )
    expect(getContentSnippets(RUN_ID).size).toBe(0)
  })

  it("captures content from a successful edit_file via new_string", () => {
    ingestToolResult(
      RUN_ID,
      "edit_file",
      { path: "src/server.ts", old_string: "// TODO", new_string: `import express from "express"` },
      { success: true },
    )
    const snippets = getContentSnippets(RUN_ID)
    expect(snippets.get("src/server.ts")).toContain("express")
  })
})

describe("getContentSnippets — batch_write", () => {
  it("captures content for every successful file in a batch_write", () => {
    ingestToolResult(
      RUN_ID,
      "batch_write",
      {
        files: [
          { path: "package.json", content: `{ "dependencies": { "express": "^4", "pg": "^8" } }` },
          { path: "src/server.ts", content: `import express from "express"\nexport default express()` },
          { path: "src/db.ts", content: `import { Pool } from "pg"\nexport const db = new Pool()` },
        ],
      },
      {
        success: true,
        files: [
          { path: "package.json", success: true },
          { path: "src/server.ts", success: true },
          { path: "src/db.ts", success: true },
        ],
      },
    )
    const snippets = getContentSnippets(RUN_ID)
    expect(snippets.size).toBe(3)
    expect(snippets.get("package.json")).toContain("express")
    expect(snippets.get("package.json")).toContain("pg")
    expect(snippets.get("src/db.ts")).toContain("Pool")
  })

  it("skips failed files in batch_write", () => {
    ingestToolResult(
      RUN_ID,
      "batch_write",
      {
        files: [
          { path: "ok.ts", content: "const ok = true" },
          { path: "fail.ts", content: "const fail = true" },
        ],
      },
      {
        success: true,
        files: [
          { path: "ok.ts", success: true },
          { path: "fail.ts", success: false, error: "permission denied" },
        ],
      },
    )
    const snippets = getContentSnippets(RUN_ID)
    expect(snippets.has("ok.ts")).toBe(true)
    expect(snippets.has("fail.ts")).toBe(false)
  })
})

describe("getContentSnippets — bounds", () => {
  it("truncates content to 1KB per file", () => {
    const huge = "x".repeat(5000) // 5KB
    ingestToolResult(
      RUN_ID,
      "write_file",
      { path: "big.txt", content: huge },
      { success: true },
    )
    const snippet = getContentSnippets(RUN_ID).get("big.txt")!
    expect(snippet.length).toBe(1024)
  })

  it("does NOT truncate content that's already under the cap", () => {
    const small = "x".repeat(100)
    ingestToolResult(
      RUN_ID,
      "write_file",
      { path: "small.txt", content: small },
      { success: true },
    )
    expect(getContentSnippets(RUN_ID).get("small.txt")!.length).toBe(100)
  })

  it("evicts oldest entries when over the 60-file cap", () => {
    // Write 65 files; we should keep the most recent 60.
    for (let i = 0; i < 65; i++) {
      ingestToolResult(
        RUN_ID,
        "write_file",
        { path: `file-${i}.ts`, content: `// ${i}` },
        { success: true },
      )
    }
    const snippets = getContentSnippets(RUN_ID)
    expect(snippets.size).toBe(60)
    // Oldest (0..4) should be gone; newest (5..64) should remain.
    expect(snippets.has("file-0.ts")).toBe(false)
    expect(snippets.has("file-4.ts")).toBe(false)
    expect(snippets.has("file-5.ts")).toBe(true)
    expect(snippets.has("file-64.ts")).toBe(true)
  })

  it("re-writing a file refreshes its insertion order (re-set + delete-first)", () => {
    // Write file-A, then 59 others, then file-A again. file-A should
    // be the YOUNGEST entry, not the oldest, because re-write moves
    // it to the back.
    ingestToolResult(RUN_ID, "write_file", { path: "file-A.ts", content: "v1" }, { success: true })
    for (let i = 0; i < 60; i++) {
      ingestToolResult(
        RUN_ID,
        "write_file",
        { path: `other-${i}.ts`, content: `// ${i}` },
        { success: true },
      )
    }
    ingestToolResult(RUN_ID, "write_file", { path: "file-A.ts", content: "v2-rewritten" }, { success: true })

    const snippets = getContentSnippets(RUN_ID)
    expect(snippets.size).toBe(60)
    // file-A was re-set so it's now the youngest — survives the cap.
    expect(snippets.has("file-A.ts")).toBe(true)
    expect(snippets.get("file-A.ts")).toBe("v2-rewritten")
  })
})

describe("getContentSnippets — clearRunContext wipes state", () => {
  it("clears the snippet index when the run is cleared", () => {
    ingestToolResult(
      RUN_ID,
      "write_file",
      { path: "x.ts", content: "const x = 1" },
      { success: true },
    )
    expect(getContentSnippets(RUN_ID).size).toBe(1)
    clearRunContext(RUN_ID)
    expect(getContentSnippets(RUN_ID).size).toBe(0)
  })
})
