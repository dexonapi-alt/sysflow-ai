/**
 * Stage 4 of `2026-05-16-accountability-and-parallel-execution-sequencing.md`.
 *
 * Already-created guard. The agent observably re-issued `write_file`
 * for paths it had already written earlier in the same run; pre-Stage-4
 * the cli executed the second write silently, overwriting the earlier
 * content. Stage 4 tracks created paths per-run and blocks duplicate
 * writes with a synthetic failure unless the agent opts in via
 * `_acknowledge_overwrite: true`.
 */

import { describe, it, expect, beforeEach } from "vitest"
import {
  shouldGuardAlreadyCreated,
  buildAlreadyCreatedResult,
  hasBeenCreatedThisRun,
  markPathCreated,
  markPathDeleted,
  clearCreatedPaths,
  getAlreadyCreatedRejectionCount,
  resetAlreadyCreatedRejectionCount,
  _resetCreatedPathsStoreForTests,
} from "../executor.js"

beforeEach(() => {
  _resetCreatedPathsStoreForTests()
  resetAlreadyCreatedRejectionCount()
})

describe("created-paths store — per-run isolation + lifecycle", () => {
  it("returns false for an unknown runId or path", () => {
    expect(hasBeenCreatedThisRun("r1", "src/index.ts")).toBe(false)
    expect(hasBeenCreatedThisRun(undefined, "src/index.ts")).toBe(false)
  })

  it("markPathCreated then hasBeenCreatedThisRun round-trips", () => {
    markPathCreated("r1", "src/index.ts")
    expect(hasBeenCreatedThisRun("r1", "src/index.ts")).toBe(true)
  })

  it("isolates paths by runId", () => {
    markPathCreated("r1", "src/a.ts")
    markPathCreated("r2", "src/b.ts")
    expect(hasBeenCreatedThisRun("r1", "src/a.ts")).toBe(true)
    expect(hasBeenCreatedThisRun("r1", "src/b.ts")).toBe(false)
    expect(hasBeenCreatedThisRun("r2", "src/b.ts")).toBe(true)
  })

  it("ignores empty / undefined runId or path (defensive)", () => {
    markPathCreated(undefined, "x.ts")
    markPathCreated("r1", "")
    expect(hasBeenCreatedThisRun(undefined, "x.ts")).toBe(false)
    expect(hasBeenCreatedThisRun("r1", "")).toBe(false)
  })

  it("clearCreatedPaths removes the entry for one run only", () => {
    markPathCreated("r1", "a.ts")
    markPathCreated("r2", "b.ts")
    clearCreatedPaths("r1")
    expect(hasBeenCreatedThisRun("r1", "a.ts")).toBe(false)
    expect(hasBeenCreatedThisRun("r2", "b.ts")).toBe(true)
  })

  it("markPathDeleted removes a path so create-delete-recreate works", () => {
    markPathCreated("r1", "draft.ts")
    expect(hasBeenCreatedThisRun("r1", "draft.ts")).toBe(true)
    markPathDeleted("r1", "draft.ts")
    expect(hasBeenCreatedThisRun("r1", "draft.ts")).toBe(false)
  })

  it("markPathDeleted on an unknown path is a no-op", () => {
    markPathDeleted("r1", "never-created.ts")
    expect(hasBeenCreatedThisRun("r1", "never-created.ts")).toBe(false)
  })
})

describe("shouldGuardAlreadyCreated — predicate", () => {
  it("returns false on first write (path not tracked)", () => {
    expect(shouldGuardAlreadyCreated({ path: "src/index.ts" }, "r1")).toBe(false)
  })

  it("returns true on second write of the same path (path tracked)", () => {
    markPathCreated("r1", "src/index.ts")
    expect(shouldGuardAlreadyCreated({ path: "src/index.ts" }, "r1")).toBe(true)
  })

  it("returns false when _acknowledge_overwrite: true is set (escape hatch)", () => {
    markPathCreated("r1", "src/index.ts")
    expect(
      shouldGuardAlreadyCreated({ path: "src/index.ts", _acknowledge_overwrite: true }, "r1"),
    ).toBe(false)
  })

  it("requires _acknowledge_overwrite to be EXACTLY true (strict — string 'true' doesn't bypass)", () => {
    markPathCreated("r1", "src/index.ts")
    expect(
      shouldGuardAlreadyCreated({ path: "src/index.ts", _acknowledge_overwrite: "true" }, "r1"),
    ).toBe(true)
    expect(
      shouldGuardAlreadyCreated({ path: "src/index.ts", _acknowledge_overwrite: 1 }, "r1"),
    ).toBe(true)
  })

  it("returns false when runId is undefined (defensive — can't track without it)", () => {
    markPathCreated("r1", "src/index.ts")
    expect(shouldGuardAlreadyCreated({ path: "src/index.ts" }, undefined)).toBe(false)
  })

  it("returns false when path is missing or not a string (defensive)", () => {
    markPathCreated("r1", "src/index.ts")
    expect(shouldGuardAlreadyCreated({}, "r1")).toBe(false)
    expect(shouldGuardAlreadyCreated({ path: 42 }, "r1")).toBe(false)
  })
})

describe("buildAlreadyCreatedResult — synthetic failure shape", () => {
  it("returns success:false + _errorCategory:'already_created' + path", () => {
    const r = buildAlreadyCreatedResult("src/index.ts")
    expect(r.success).toBe(false)
    expect(r._errorCategory).toBe("already_created")
    expect(r.path).toBe("src/index.ts")
  })

  it("includes the file path in the error message", () => {
    const r = buildAlreadyCreatedResult("src/db.ts")
    expect((r.error as string)).toContain("src/db.ts")
  })

  it("instructs the agent on the three resolution actions (edit / read / acknowledge)", () => {
    const msg = (buildAlreadyCreatedResult("a.ts").error as string).toLowerCase()
    expect(msg).toContain("edit_file")
    expect(msg).toContain("read_file")
    expect(msg).toContain("_acknowledge_overwrite")
  })

  it("JSON-serialises cleanly (wire-format contract)", () => {
    const round = JSON.parse(JSON.stringify(buildAlreadyCreatedResult("x.ts")))
    expect(round.success).toBe(false)
    expect(round._errorCategory).toBe("already_created")
    expect(round.path).toBe("x.ts")
  })
})

describe("getAlreadyCreatedRejectionCount — telemetry counter", () => {
  it("starts at 0 after reset", () => {
    expect(getAlreadyCreatedRejectionCount()).toBe(0)
  })

  it("survives a counter-reset between runs (telemetry is per-run)", () => {
    // No direct bumper exported — bump happens inside executeToolLocally.
    // The counter being at 0 after reset is the test surface available
    // for the pure module; integration with the dispatch path is
    // covered indirectly by the predicate tests above.
    resetAlreadyCreatedRejectionCount()
    expect(getAlreadyCreatedRejectionCount()).toBe(0)
  })
})

describe("end-to-end — user-reported re-creation pattern", () => {
  it("first write of src/index.ts is allowed; second is blocked", () => {
    expect(shouldGuardAlreadyCreated({ path: "src/index.ts" }, "r1")).toBe(false)
    // Simulate successful first write.
    markPathCreated("r1", "src/index.ts")
    // Second emission of the same write_file in this run trips the guard.
    expect(shouldGuardAlreadyCreated({ path: "src/index.ts" }, "r1")).toBe(true)
  })

  it("agent can bypass with explicit acknowledge if intentional overwrite", () => {
    markPathCreated("r1", "src/index.ts")
    expect(
      shouldGuardAlreadyCreated(
        { path: "src/index.ts", _acknowledge_overwrite: true, content: "v2" },
        "r1",
      ),
    ).toBe(false)
  })

  it("after delete_file, create-delete-recreate flow works without acknowledge", () => {
    markPathCreated("r1", "scratch.ts")
    // Agent decides to delete + redo.
    markPathDeleted("r1", "scratch.ts")
    // Recreate is now allowed because the path was cleared from the set.
    expect(shouldGuardAlreadyCreated({ path: "scratch.ts" }, "r1")).toBe(false)
  })

  it("multiple paths in the same run track independently", () => {
    markPathCreated("r1", "a.ts")
    markPathCreated("r1", "b.ts")
    markPathCreated("r1", "c.ts")
    expect(shouldGuardAlreadyCreated({ path: "a.ts" }, "r1")).toBe(true)
    expect(shouldGuardAlreadyCreated({ path: "b.ts" }, "r1")).toBe(true)
    expect(shouldGuardAlreadyCreated({ path: "c.ts" }, "r1")).toBe(true)
    expect(shouldGuardAlreadyCreated({ path: "d.ts" }, "r1")).toBe(false)
  })
})
