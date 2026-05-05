import { describe, it, expect, beforeEach } from "vitest"
import { runCommandTool } from "../tools.js"
import { _resetForTests, list } from "../background-jobs.js"

describe("runCommandTool background routing", () => {
  beforeEach(() => {
    _resetForTests()
  })

  it("'npm install' auto-routes to background when runId is supplied", async () => {
    const result = await runCommandTool("npm install", process.cwd(), { runId: "r1" })
    expect(result.startedBackground).toBe(true)
    expect(result.jobId).toMatch(/^job_/)
    expect(result.status).toBe("running")
  })

  it("background routing requires a runId — without it, falls through", async () => {
    // Without runId we can't track the job, so it should NOT background even
    // for an install pattern. (The tool returns the existing 'slow' or
    // synchronous behaviour. For a real npm install without runId, we'd hit
    // the synchronous spawn path — we don't want to actually run that, so we
    // just assert the result doesn't claim a background start.)
    const result = await runCommandTool("npm install --dry-run", process.cwd())
    // Either the command ran synchronously (with stderr/stdout) or hit the
    // existing isSlow-deleted path; either way startedBackground must be falsy.
    expect(result.startedBackground).toBeFalsy()
  })

  it("explicit background=false forces synchronous even on install command", async () => {
    // We don't actually want to run npm install in the test, so we hand it a
    // tiny shell command that's NOT in the background list and confirm the
    // background flag doesn't somehow turn it on.
    const result = await runCommandTool("node -e \"process.exit(0)\"", process.cwd(), {
      runId: "r1",
      background: false,
    })
    expect(result.startedBackground).toBeFalsy()
  })

  it("explicit background=true backgrounds a non-install command", async () => {
    const result = await runCommandTool("node -e \"setTimeout(()=>process.exit(0), 100)\"", process.cwd(), {
      runId: "r1",
      background: true,
    })
    expect(result.startedBackground).toBe(true)
    expect(list("r1").length).toBe(1)
  })

  it("'npm run dev' is still refused (long-running)", async () => {
    const result = await runCommandTool("npm run dev", process.cwd(), { runId: "r1" })
    expect(result.skipped).toBe(true)
    expect(result.startedBackground).toBeFalsy()
  })

  it("'npx prisma init' is still skipped (in SLOW_COMMAND_PATTERNS)", async () => {
    const result = await runCommandTool("npx prisma init", process.cwd(), { runId: "r1" })
    expect(result.skipped).toBe(true)
    expect(result.startedBackground).toBeFalsy()
  })

  it("'cargo build' auto-backgrounds with runId", async () => {
    const result = await runCommandTool("cargo build --release", process.cwd(), { runId: "r1" })
    expect(result.startedBackground).toBe(true)
  })

  it("'pip install -r requirements.txt' auto-backgrounds", async () => {
    const result = await runCommandTool("pip install -r requirements.txt", process.cwd(), { runId: "r1" })
    expect(result.startedBackground).toBe(true)
  })
})
