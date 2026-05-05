import { describe, it, expect, beforeEach } from "vitest"
import { start, poll, list, wait, cleanupRun, forget, _resetForTests, _CONFIG } from "../background-jobs.js"

const SLEEP_MS = (ms: number): string => `node -e "setTimeout(()=>process.exit(0), ${ms})"`
const FAIL_FAST = `node -e "process.exit(7)"`
const SLOW_OUTPUT = `node -e "console.log('hi'); setTimeout(()=>process.exit(0), 200)"`

describe("background-jobs", () => {
  beforeEach(() => {
    _resetForTests()
  })

  it("start returns a running job state immediately", () => {
    const state = start({ command: SLEEP_MS(100), cwd: process.cwd(), runId: "r1" })
    expect(state.status).toBe("running")
    expect(state.id).toMatch(/^job_/)
    expect(state.runId).toBe("r1")
  })

  it("poll returns done with exitCode=0 after success", async () => {
    const state = start({ command: SLEEP_MS(50), cwd: process.cwd(), runId: "r1" })
    const final = await wait(state.id, 1000)
    expect(final.status).toBe("done")
    expect(final.exitCode).toBe(0)
    expect(final.durationMs).toBeGreaterThanOrEqual(50)
  })

  it("poll returns failed with non-zero exit", async () => {
    const state = start({ command: FAIL_FAST, cwd: process.cwd(), runId: "r1" })
    const final = await wait(state.id, 1000)
    expect(final.status).toBe("failed")
    expect(final.exitCode).toBe(7)
  })

  it("captures stdout tail", async () => {
    const state = start({ command: SLOW_OUTPUT, cwd: process.cwd(), runId: "r1" })
    const final = await wait(state.id, 1000)
    expect(final.status).toBe("done")
    expect(final.stdoutTail).toContain("hi")
  })

  it("MAX_CONCURRENT_PER_RUN cap throws on the 4th start", () => {
    for (let i = 0; i < _CONFIG.MAX_CONCURRENT_PER_RUN; i++) {
      start({ command: SLEEP_MS(500), cwd: process.cwd(), runId: "r1" })
    }
    expect(() => start({ command: SLEEP_MS(500), cwd: process.cwd(), runId: "r1" })).toThrow(/Too many concurrent/)
  })

  it("cap is per-run, not global", () => {
    for (let i = 0; i < _CONFIG.MAX_CONCURRENT_PER_RUN; i++) {
      start({ command: SLEEP_MS(500), cwd: process.cwd(), runId: "r-A" })
    }
    // Different runId — cap should reset.
    expect(() => start({ command: SLEEP_MS(50), cwd: process.cwd(), runId: "r-B" })).not.toThrow()
  })

  it("wait with short timeout returns running for an in-flight job", async () => {
    const state = start({ command: SLEEP_MS(500), cwd: process.cwd(), runId: "r1" })
    const probe = await wait(state.id, 50)
    expect(probe.status).toBe("running")
  })

  it("wait on unknown jobId resolves to a synthetic failed", async () => {
    const probe = await wait("job_none", 10)
    expect(probe.status).toBe("failed")
    expect(probe.stderrTail).toMatch(/unknown jobId/)
  })

  it("list returns running jobs first", async () => {
    const a = start({ command: SLEEP_MS(20), cwd: process.cwd(), runId: "r1" })
    const b = start({ command: SLEEP_MS(500), cwd: process.cwd(), runId: "r1" })
    await wait(a.id, 200)  // 'a' completes; 'b' still running
    const out = list("r1")
    expect(out.length).toBe(2)
    expect(out[0].status).toBe("running")
    expect(out[0].id).toBe(b.id)
  })

  it("list isolates by runId", () => {
    start({ command: SLEEP_MS(50), cwd: process.cwd(), runId: "r1" })
    start({ command: SLEEP_MS(50), cwd: process.cwd(), runId: "r2" })
    expect(list("r1").length).toBe(1)
    expect(list("r2").length).toBe(1)
  })

  it("cleanupRun awaits running jobs and reports counts", async () => {
    start({ command: SLEEP_MS(30), cwd: process.cwd(), runId: "r1" })
    start({ command: SLEEP_MS(30), cwd: process.cwd(), runId: "r1" })
    const result = await cleanupRun("r1", 1000)
    expect(result.awaited).toBe(2)
    expect(result.aborted).toBe(0)
  })

  it("cleanupRun aborts jobs that exceed the wait window", async () => {
    start({ command: SLEEP_MS(2000), cwd: process.cwd(), runId: "r1" })
    const result = await cleanupRun("r1", 80)
    expect(result.aborted).toBe(1)
  })

  it("forget removes a finished job", async () => {
    const state = start({ command: SLEEP_MS(20), cwd: process.cwd(), runId: "r1" })
    await wait(state.id, 500)
    forget(state.id)
    expect(poll(state.id)).toBeNull()
  })

  it("poll on unknown jobId returns null", () => {
    expect(poll("job_none")).toBeNull()
  })
})
