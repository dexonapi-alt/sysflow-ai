import { describe, it, expect } from "vitest"
import {
  buildVerifyAfterWriteBlock,
  extractWritesFromToolResults,
} from "../post-write-verifier.js"
import { shouldForceVerifyAfterWrite } from "../free-tier-policy.js"

/**
 * Stage 1 of free-tier quality enforcement: verify-after-write block
 * generator + free-tier gate.
 */

describe("buildVerifyAfterWriteBlock — content", () => {
  it("returns empty string when nothing was written", () => {
    expect(buildVerifyAfterWriteBlock({ filesWritten: [], dirsCreated: [], platform: "linux" })).toBe("")
  })

  it("emits cat commands on Linux/Mac for each written file", () => {
    const out = buildVerifyAfterWriteBlock({
      filesWritten: ["src/App.tsx", "src/index.tsx"],
      dirsCreated: [],
      platform: "linux",
    })
    expect(out).toContain("VERIFY THE LAST CHUNK")
    expect(out).toContain("cat src/App.tsx")
    expect(out).toContain("cat src/index.tsx")
    expect(out).not.toContain("Get-Content")
  })

  it("emits Get-Content on Windows for each written file", () => {
    const out = buildVerifyAfterWriteBlock({
      filesWritten: ["src\\App.tsx"],
      dirsCreated: [],
      platform: "win32",
    })
    expect(out).toContain("Get-Content src\\App.tsx")
    expect(out).not.toContain("cat src")
  })

  it("caps the per-block file list at 4 and surfaces +N more hint", () => {
    const out = buildVerifyAfterWriteBlock({
      filesWritten: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts"],
      dirsCreated: [],
      platform: "linux",
    })
    expect(out).toContain("cat a.ts")
    expect(out).toContain("cat d.ts")
    expect(out).not.toContain("cat e.ts")
    expect(out).toContain("+ 2 more file(s)")
  })

  it("emits find for created directories on Linux", () => {
    const out = buildVerifyAfterWriteBlock({
      filesWritten: [],
      dirsCreated: ["src/components", "src/lib"],
      platform: "linux",
    })
    expect(out).toContain("created directories aren't empty")
    expect(out).toContain("find src/components -type f")
    expect(out).toContain("find src/lib -type f")
  })

  it("emits Get-ChildItem -Recurse on Windows for dirs", () => {
    const out = buildVerifyAfterWriteBlock({
      filesWritten: [],
      dirsCreated: ["src\\components"],
      platform: "win32",
    })
    expect(out).toContain("Get-ChildItem -Recurse src\\components")
    expect(out).not.toContain("find src")
  })

  it("includes `npm run typecheck` when TypeScript files were written", () => {
    const out = buildVerifyAfterWriteBlock({
      filesWritten: ["src/App.tsx", "src/util.ts"],
      dirsCreated: [],
      platform: "linux",
    })
    expect(out).toContain("npm run typecheck")
  })

  it("falls back to `node --check` when JS (but no TS) files were written", () => {
    const out = buildVerifyAfterWriteBlock({
      filesWritten: ["src/App.js", "src/util.mjs"],
      dirsCreated: [],
      platform: "linux",
    })
    expect(out).toContain("node --check")
    expect(out).not.toContain("npm run typecheck")
  })

  it("does NOT include the typecheck/node-check command for Python / Go / Rust runs", () => {
    const out = buildVerifyAfterWriteBlock({
      filesWritten: ["src/app.py", "src/util.go"],
      dirsCreated: [],
      platform: "linux",
    })
    // The trailing reasoningChain reminder mentions "typecheck" as a
    // concept; we just want to confirm no actual `npm run typecheck`
    // command line was emitted for a non-TS/JS run.
    expect(out).not.toContain("npm run typecheck")
    expect(out).not.toContain("node --check")
  })

  it("includes the closing 'reason in reasoningChain' directive", () => {
    const out = buildVerifyAfterWriteBlock({
      filesWritten: ["src/App.tsx"],
      dirsCreated: [],
      platform: "linux",
    })
    expect(out).toContain("reason in `reasoningChain`")
    expect(out).toContain("If anything failed, fix it FIRST")
  })
})

describe("extractWritesFromToolResults", () => {
  it("extracts file paths from write_file / edit_file results", () => {
    const out = extractWritesFromToolResults({
      tools: [
        { tool: "write_file", result: { path: "src/App.tsx", success: true } },
        { tool: "edit_file", result: { path: "src/index.tsx" } },
      ],
    })
    expect(out.filesWritten).toEqual(["src/App.tsx", "src/index.tsx"])
    expect(out.dirsCreated).toEqual([])
  })

  it("extracts dirs from create_directory results", () => {
    const out = extractWritesFromToolResults({
      tools: [
        { tool: "create_directory", result: { path: "src/components" } },
      ],
    })
    expect(out.filesWritten).toEqual([])
    expect(out.dirsCreated).toEqual(["src/components"])
  })

  it("extracts multiple paths from batch_write `paths` array", () => {
    const out = extractWritesFromToolResults({
      tools: [
        { tool: "batch_write", result: { paths: ["a.ts", "b.ts", "c.ts"] } },
      ],
    })
    expect(out.filesWritten).toEqual(["a.ts", "b.ts", "c.ts"])
  })

  it("skips failed writes (success: false or error)", () => {
    const out = extractWritesFromToolResults({
      tools: [
        { tool: "write_file", result: { path: "ok.ts", success: true } },
        { tool: "write_file", result: { path: "fail.ts", success: false } },
        { tool: "write_file", result: { path: "errd.ts", error: "permission denied" } },
      ],
    })
    expect(out.filesWritten).toEqual(["ok.ts"])
  })

  it("de-dupes paths written by multiple ops in the same chunk", () => {
    const out = extractWritesFromToolResults({
      tools: [
        { tool: "write_file", result: { path: "shared.ts" } },
        { tool: "edit_file", result: { path: "shared.ts" } },
      ],
    })
    expect(out.filesWritten).toEqual(["shared.ts"])
  })

  it("ignores non-write tools (read_file, run_command, etc.)", () => {
    const out = extractWritesFromToolResults({
      tools: [
        { tool: "read_file", result: { path: "src/App.tsx" } },
        { tool: "run_command", result: { stdout: "files visible" } },
        { tool: "list_directory", result: { entries: [] } },
      ],
    })
    expect(out.filesWritten).toEqual([])
    expect(out.dirsCreated).toEqual([])
  })

  it("gracefully handles empty / null tool list", () => {
    expect(extractWritesFromToolResults({ tools: [] })).toEqual({ filesWritten: [], dirsCreated: [] })
    expect(extractWritesFromToolResults({ tools: null as unknown as never })).toEqual({ filesWritten: [], dirsCreated: [] })
  })
})

describe("shouldForceVerifyAfterWrite — gate matrix", () => {
  const base = {
    model: "gemini-flash" as string | null,
    complexity: "medium" as "simple" | "medium" | "complex" | null,
    filesWrittenInChunk: 2,
    flagEnabled: true,
  }

  it("returns false when the flag is off", () => {
    expect(shouldForceVerifyAfterWrite({ ...base, flagEnabled: false })).toBe(false)
  })

  it("returns false when no files were written this chunk", () => {
    expect(shouldForceVerifyAfterWrite({ ...base, filesWrittenInChunk: 0 })).toBe(false)
  })

  it("fires for free-tier models regardless of file count or complexity", () => {
    for (const model of ["openrouter-auto", "meta-llama/llama-3.1-405b", "mistralai/mistral-large"]) {
      expect(shouldForceVerifyAfterWrite({
        ...base, model, filesWrittenInChunk: 1, complexity: "simple",
      })).toBe(true)
    }
  })

  it("does NOT fire for paid models on small chunks (< 3 files)", () => {
    expect(shouldForceVerifyAfterWrite({
      ...base, model: "claude-sonnet", filesWrittenInChunk: 2, complexity: "medium",
    })).toBe(false)
  })

  it("does NOT fire for paid models on simple-complexity tasks (even with many files)", () => {
    expect(shouldForceVerifyAfterWrite({
      ...base, model: "claude-sonnet", filesWrittenInChunk: 10, complexity: "simple",
    })).toBe(false)
  })

  it("fires for paid models on medium/complex tasks with ≥ 3 files", () => {
    expect(shouldForceVerifyAfterWrite({
      ...base, model: "claude-sonnet", filesWrittenInChunk: 3, complexity: "medium",
    })).toBe(true)
    expect(shouldForceVerifyAfterWrite({
      ...base, model: "claude-opus", filesWrittenInChunk: 5, complexity: "complex",
    })).toBe(true)
  })
})
