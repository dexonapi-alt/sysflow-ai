/**
 * Plan `2026-05-16-agent-code-correctness-and-completion-artifacts.md` Stage 3.
 *
 * Tests for the pre-completion tsc gate. The runTscGate orchestrator
 * is exercised via the pure helpers (hasAuthoredTsFiles, hasTsConfig,
 * extractTscErrors, buildTscFailedInject) — the actual tsc subprocess
 * is end-to-end tested manually since it depends on the user's
 * installed tsc.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import {
  hasAuthoredTsFiles,
  hasTsConfig,
  runTscGate,
  extractTscErrors,
  buildTscFailedInject,
  type TscGateResult,
} from "../tsc-completion-gate.js"

describe("hasAuthoredTsFiles", () => {
  it("returns true when any file has .ts extension", () => {
    expect(hasAuthoredTsFiles(["package.json", "src/index.ts"])).toBe(true)
  })

  it("returns true when any file has .tsx extension", () => {
    expect(hasAuthoredTsFiles(["src/App.tsx"])).toBe(true)
  })

  it("returns false when no .ts/.tsx files", () => {
    expect(hasAuthoredTsFiles(["package.json", "src/index.js", "README.md"])).toBe(false)
  })

  it("returns false on empty list", () => {
    expect(hasAuthoredTsFiles([])).toBe(false)
  })

  it("returns false on Python-only authored files", () => {
    expect(hasAuthoredTsFiles(["main.py", "tests/test_main.py", "requirements.txt"])).toBe(false)
  })
})

describe("hasTsConfig", () => {
  let tmp: string
  beforeEach(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sysflow-tsc-gate-")) })
  afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }) })

  it("returns true when tsconfig.json exists in cwd", async () => {
    await fs.writeFile(path.join(tmp, "tsconfig.json"), "{}", "utf8")
    expect(await hasTsConfig(tmp)).toBe(true)
  })

  it("returns false when tsconfig.json is absent", async () => {
    expect(await hasTsConfig(tmp)).toBe(false)
  })

  it("returns false for non-existent cwd", async () => {
    expect(await hasTsConfig(path.join(tmp, "does-not-exist"))).toBe(false)
  })
})

describe("extractTscErrors", () => {
  it("extracts canonical tsc error lines", () => {
    const output = [
      "src/index.ts(12,5): error TS2304: Cannot find name 'foo'.",
      "src/routes/auth.ts(7,1): error TS2307: Cannot find module './db'.",
      "Found 2 errors.",
    ].join("\n")
    const errors = extractTscErrors(output)
    expect(errors).toHaveLength(2)
    expect(errors[0]).toContain("TS2304")
    expect(errors[1]).toContain("TS2307")
  })

  it("extracts pretty-format tsc errors", () => {
    const output = "src/index.ts:5:10 - error TS2305: Module has no exported member 'X'."
    const errors = extractTscErrors(output)
    expect(errors).toHaveLength(1)
  })

  it("returns empty list when output has no errors", () => {
    expect(extractTscErrors("")).toEqual([])
    expect(extractTscErrors("Found 0 errors.")).toEqual([])
    expect(extractTscErrors("compilation completed successfully\n")).toEqual([])
  })

  it("filters out non-error lines (Watching... Found N errors. etc.)", () => {
    const output = [
      "Watching for file changes.",
      "src/index.ts(1,1): error TS1234: Some error.",
      "Found 1 error.",
      "Process finished.",
    ].join("\n")
    expect(extractTscErrors(output)).toEqual(["src/index.ts(1,1): error TS1234: Some error."])
  })

  it("tolerates empty / null / undefined input", () => {
    expect(extractTscErrors("")).toEqual([])
    expect(extractTscErrors(null as unknown as string)).toEqual([])
    expect(extractTscErrors(undefined as unknown as string)).toEqual([])
  })

  it("extracts errors from .tsx and .d.ts files", () => {
    const output = [
      "src/App.tsx(3,10): error TS2322: Type 'string' is not assignable to type 'number'.",
      "types/api.d.ts(15,5): error TS2305: Module has no exported member 'X'.",
    ].join("\n")
    const errors = extractTscErrors(output)
    expect(errors).toHaveLength(2)
  })
})

describe("buildTscFailedInject", () => {
  const sampleResult: TscGateResult = {
    ran: true,
    ok: false,
    errorCount: 3,
    errors: [
      "src/index.ts(12,5): error TS2304: Cannot find name 'authRoutes'.",
      "src/routes/auth.ts(7,1): error TS2307: Cannot find module './db'.",
      "src/middleware/auth.ts(1,30): error TS2305: Module 'express' has no exported member 'NextFunction'.",
    ],
  }

  it("renders the canonical header + footer markers", () => {
    const out = buildTscFailedInject(sampleResult)
    expect(out).toContain("═══ TYPECHECK FAILED — FIX BEFORE COMPLETION ═══")
    expect(out).toContain("═══ END TYPECHECK FAILED ═══")
  })

  it("includes the error count", () => {
    const out = buildTscFailedInject(sampleResult)
    expect(out).toContain("3 errors")
  })

  it("uses singular 'error' for one error", () => {
    const single: TscGateResult = { ran: true, ok: false, errorCount: 1, errors: ["x"] }
    const out = buildTscFailedInject(single)
    expect(out).toContain("1 error")
    expect(out).not.toMatch(/\b1 errors\b/)
  })

  it("includes each error line indented", () => {
    const out = buildTscFailedInject(sampleResult)
    expect(out).toContain("  src/index.ts(12,5): error TS2304")
    expect(out).toContain("  src/routes/auth.ts(7,1): error TS2307")
    expect(out).toContain("  src/middleware/auth.ts(1,30): error TS2305")
  })

  it("includes the '... and N more' tail when errorCount > errors.length", () => {
    const truncated: TscGateResult = {
      ran: true,
      ok: false,
      errorCount: 15,
      errors: ["a", "b", "c"],
    }
    const out = buildTscFailedInject(truncated)
    expect(out).toContain("… and 12 more")
  })

  it("includes the REQUIRED next-turn instructions with Stage 1 rule references", () => {
    const out = buildTscFailedInject(sampleResult)
    expect(out).toContain("REQUIRED for your next turn")
    expect(out).toContain("Missing .ts extension")
    expect(out).toContain("`import type`")
    expect(out).toContain("Default imported when source has only named exports")
  })

  it("warns against re-declaring completion until tsc is clean", () => {
    const out = buildTscFailedInject(sampleResult)
    expect(out).toContain("Do NOT declare 'completed' again")
    expect(out).toContain("zero errors")
  })
})

describe("runTscGate — skip paths", () => {
  let tmp: string
  beforeEach(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sysflow-tsc-skip-")) })
  afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }) })

  it("skips when no .ts/.tsx files authored", async () => {
    const result = await runTscGate({ cwd: tmp, filesWritten: ["package.json", "README.md"] })
    expect(result.ran).toBe(false)
    expect(result.ok).toBe(true)
    expect(result.skippedReason).toContain("no .ts/.tsx files")
  })

  it("skips when tsconfig.json is missing", async () => {
    const result = await runTscGate({ cwd: tmp, filesWritten: ["src/index.ts"] })
    expect(result.ran).toBe(false)
    expect(result.ok).toBe(true)
    expect(result.skippedReason).toContain("no tsconfig.json")
  })
})
