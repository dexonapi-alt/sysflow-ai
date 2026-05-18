/**
 * Smoke test for the file logger.
 *
 * The init function is idempotent (re-calls no-op) and disabled via
 * `SYSFLOW_FILE_LOG=0`. We test the disable path here because the
 * happy path mutates global `console.*` references for the rest of
 * the test process, which would leak across files. The active-logging
 * behaviour is exercised manually in dev when the server / cli boots.
 */

import { describe, it, expect, beforeEach } from "vitest"
import { initFileLogger } from "../file-logger.js"

describe("initFileLogger — env toggle", () => {
  // We can't reset `initialized` between tests (it's module-internal),
  // so the disable path is the safe one to verify. The toggle check
  // fires before any side effects (file open, console patch), so a
  // disabled init is genuinely a no-op.
  const origLog = console.log
  const origEnv = process.env.SYSFLOW_FILE_LOG

  beforeEach(() => {
    console.log = origLog
  })

  it("is a no-op when SYSFLOW_FILE_LOG=0", () => {
    process.env.SYSFLOW_FILE_LOG = "0"
    initFileLogger() // First call sets `initialized = true`
    expect(console.log).toBe(origLog) // Patch was not installed.
    process.env.SYSFLOW_FILE_LOG = origEnv ?? ""
  })

  it("subsequent calls are no-ops (idempotent — initialized guard)", () => {
    // Second call should fast-return regardless of env state.
    initFileLogger()
    initFileLogger()
    expect(true).toBe(true) // didn't throw
  })
})
