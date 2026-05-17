/**
 * Stage 3 of `2026-05-16-accountability-and-parallel-execution-sequencing.md`.
 *
 * Pure tests for the read-after-write inject helpers. The inject
 * fires AT MOST ONCE per run when the agent's first batch of
 * write_file calls lands on a fresh scaffold (repoState empty / small)
 * — forcing the agent to batch_read what it just wrote before issuing
 * another write batch.
 */

import { describe, it, expect, beforeEach } from "vitest"
import {
  extractSuccessfulWritePaths,
  shouldFireReadAfterWriteInject,
  buildReadAfterWriteInject,
  markReadAfterWriteFired,
  clearReadAfterWriteState,
  getReadAfterWriteLatchState,
  _resetReadAfterWriteStoreForTests,
} from "../read-after-write-inject.js"

beforeEach(() => {
  _resetReadAfterWriteStoreForTests()
})

describe("extractSuccessfulWritePaths — collect paths from tool results", () => {
  it("returns an empty array when no tool result is supplied", () => {
    expect(extractSuccessfulWritePaths(undefined, undefined)).toEqual([])
  })

  it("collects a single successful write_file path", () => {
    const result = extractSuccessfulWritePaths(
      { tool: "write_file", result: { path: "src/index.ts", success: true } },
      undefined,
    )
    expect(result).toEqual(["src/index.ts"])
  })

  it("skips failed writes (success: false)", () => {
    const result = extractSuccessfulWritePaths(
      { tool: "write_file", result: { path: "src/bad.ts", success: false } },
      undefined,
    )
    expect(result).toEqual([])
  })

  it("skips writes with an error field (defensive)", () => {
    const result = extractSuccessfulWritePaths(
      { tool: "write_file", result: { path: "src/bad.ts", error: "permission denied" } },
      undefined,
    )
    expect(result).toEqual([])
  })

  it("collects successful paths from a toolResults batch", () => {
    const result = extractSuccessfulWritePaths(undefined, [
      { tool: "write_file", result: { path: "package.json", success: true } },
      { tool: "write_file", result: { path: "tsconfig.json", success: true } },
      { tool: "write_file", result: { path: "src/index.ts", success: true } },
    ])
    expect(result).toEqual(["package.json", "tsconfig.json", "src/index.ts"])
  })

  it("mixes single + batch successes", () => {
    const result = extractSuccessfulWritePaths(
      { tool: "write_file", result: { path: "a.ts", success: true } },
      [
        { tool: "write_file", result: { path: "b.ts", success: true } },
        { tool: "write_file", result: { path: "c.ts", success: false } },
      ],
    )
    expect(result).toEqual(["a.ts", "b.ts"])
  })

  it("filters non-write tools from the batch", () => {
    const result = extractSuccessfulWritePaths(undefined, [
      { tool: "create_directory", result: { path: "src", success: true } },
      { tool: "write_file", result: { path: "src/index.ts", success: true } },
      { tool: "read_file", result: { path: "README.md", success: true, content: "..." } },
    ])
    expect(result).toEqual(["src/index.ts"])
  })

  it("walks batch_write per-file successes (legacy fallback)", () => {
    const result = extractSuccessfulWritePaths(undefined, [
      {
        tool: "batch_write",
        result: {
          files: [
            { path: "a.ts", success: true },
            { path: "b.ts", success: false, error: "x" },
            { path: "c.ts", success: true },
          ],
        },
      },
    ])
    expect(result).toEqual(["a.ts", "c.ts"])
  })

  it("ignores missing / non-string paths defensively", () => {
    const result = extractSuccessfulWritePaths(undefined, [
      { tool: "write_file", result: { success: true } },
      { tool: "write_file", result: { path: 42, success: true } },
      { tool: "write_file", result: { path: "ok.ts", success: true } },
    ])
    expect(result).toEqual(["ok.ts"])
  })
})

describe("shouldFireReadAfterWriteInject — predicate gates", () => {
  it("fires when state=pending, repoState=empty, writes present", () => {
    expect(
      shouldFireReadAfterWriteInject({
        runId: "r1",
        repoState: "empty",
        writtenPaths: ["src/index.ts"],
      }),
    ).toBe(true)
  })

  it("fires for repoState=small", () => {
    expect(
      shouldFireReadAfterWriteInject({
        runId: "r1",
        repoState: "small",
        writtenPaths: ["src/a.ts"],
      }),
    ).toBe(true)
  })

  it("does NOT fire for repoState=existing-small (post-scaffold edits don't need this)", () => {
    expect(
      shouldFireReadAfterWriteInject({
        runId: "r1",
        repoState: "existing-small",
        writtenPaths: ["src/a.ts"],
      }),
    ).toBe(false)
  })

  it("does NOT fire for repoState=existing-large", () => {
    expect(
      shouldFireReadAfterWriteInject({
        runId: "r1",
        repoState: "existing-large",
        writtenPaths: ["src/a.ts"],
      }),
    ).toBe(false)
  })

  it("does NOT fire when repoState is null/undefined (project-init didn't fire)", () => {
    expect(
      shouldFireReadAfterWriteInject({
        runId: "r1",
        repoState: null,
        writtenPaths: ["src/a.ts"],
      }),
    ).toBe(false)
    expect(
      shouldFireReadAfterWriteInject({
        runId: "r1",
        repoState: undefined,
        writtenPaths: ["src/a.ts"],
      }),
    ).toBe(false)
  })

  it("does NOT fire when there are no successful writes", () => {
    expect(
      shouldFireReadAfterWriteInject({
        runId: "r1",
        repoState: "empty",
        writtenPaths: [],
      }),
    ).toBe(false)
  })

  it("does NOT fire on the SECOND batch after the latch has been set (one-shot)", () => {
    // First call fires.
    expect(
      shouldFireReadAfterWriteInject({
        runId: "r1",
        repoState: "empty",
        writtenPaths: ["src/index.ts"],
      }),
    ).toBe(true)
    markReadAfterWriteFired("r1")
    // Second call does not.
    expect(
      shouldFireReadAfterWriteInject({
        runId: "r1",
        repoState: "empty",
        writtenPaths: ["src/routes/auth.ts"],
      }),
    ).toBe(false)
  })

  it("does NOT fire when runId is empty (defensive)", () => {
    expect(
      shouldFireReadAfterWriteInject({
        runId: "",
        repoState: "empty",
        writtenPaths: ["a.ts"],
      }),
    ).toBe(false)
  })

  it("clearReadAfterWriteState resets the latch so a new run can fire", () => {
    markReadAfterWriteFired("r1")
    expect(getReadAfterWriteLatchState("r1")).toBe("fired")
    clearReadAfterWriteState("r1")
    // After clear, a fresh fire-check is allowed.
    expect(
      shouldFireReadAfterWriteInject({
        runId: "r1",
        repoState: "empty",
        writtenPaths: ["a.ts"],
      }),
    ).toBe(true)
  })

  it("isolates the latch by runId", () => {
    markReadAfterWriteFired("r1")
    expect(
      shouldFireReadAfterWriteInject({
        runId: "r2",
        repoState: "empty",
        writtenPaths: ["a.ts"],
      }),
    ).toBe(true)
  })
})

describe("buildReadAfterWriteInject — block contents", () => {
  it("includes the READ-AFTER-WRITE REQUIRED markers", () => {
    const block = buildReadAfterWriteInject(["src/index.ts"])
    expect(block).toContain("═══ READ-AFTER-WRITE REQUIRED ═══")
    expect(block).toContain("═══ END READ-AFTER-WRITE REQUIRED ═══")
  })

  it("lists every written path as a bullet", () => {
    const block = buildReadAfterWriteInject(["package.json", "tsconfig.json", "src/index.ts"])
    expect(block).toContain("  - package.json")
    expect(block).toContain("  - tsconfig.json")
    expect(block).toContain("  - src/index.ts")
  })

  it("reports the file count", () => {
    const block = buildReadAfterWriteInject(["a.ts", "b.ts"])
    expect(block).toContain("2 files")
  })

  it("uses singular form for a single file", () => {
    const block = buildReadAfterWriteInject(["only.ts"])
    expect(block).toContain("1 file")
    expect(block).not.toContain("1 files")
  })

  it("instructs the agent to use batch_read", () => {
    const block = buildReadAfterWriteInject(["a.ts"])
    expect(block.toLowerCase()).toContain("batch_read")
  })

  it("instructs the agent NOT to issue another write batch first", () => {
    const block = buildReadAfterWriteInject(["a.ts"])
    expect(block.toLowerCase()).toContain("do not issue another write_file batch")
  })

  it("caps the list at MAX_LIST_PATHS (12) and reports remainder", () => {
    const paths = Array.from({ length: 20 }, (_, i) => `file-${i}.ts`)
    const block = buildReadAfterWriteInject(paths)
    expect(block).toContain("  - file-0.ts")
    expect(block).toContain("  - file-11.ts")
    expect(block).not.toContain("  - file-12.ts") // capped
    expect(block).toContain("and 8 more files")
  })

  it("handles an empty list defensively (block still well-formed)", () => {
    const block = buildReadAfterWriteInject([])
    expect(block).toContain("═══ READ-AFTER-WRITE REQUIRED ═══")
    expect(block).toContain("0 files")
  })
})

describe("end-to-end — user-reported pattern", () => {
  it("fires on the agent's first batch of writes in a fresh scaffold", () => {
    // Simulate: agent's user_message turn classified repoState=empty;
    // first tool_result turn is a write batch.
    expect(
      shouldFireReadAfterWriteInject({
        runId: "r-user-repro",
        repoState: "empty",
        writtenPaths: ["package.json", "tsconfig.json", "src/index.ts", "src/routes/auth.ts"],
      }),
    ).toBe(true)
  })

  it("does NOT re-fire on the SECOND write batch in the same scaffold (latch holds)", () => {
    shouldFireReadAfterWriteInject({
      runId: "r-user-repro",
      repoState: "empty",
      writtenPaths: ["package.json"],
    })
    markReadAfterWriteFired("r-user-repro")
    expect(
      shouldFireReadAfterWriteInject({
        runId: "r-user-repro",
        repoState: "empty",
        writtenPaths: ["src/middleware/auth.ts"],
      }),
    ).toBe(false)
  })

  it("does NOT fire on existing-large repos (the agent is editing, not scaffolding)", () => {
    expect(
      shouldFireReadAfterWriteInject({
        runId: "r-existing",
        repoState: "existing-large",
        writtenPaths: ["src/feature.ts"],
      }),
    ).toBe(false)
  })
})
