import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { recordRunSummary } from "../usage-log.js"

describe("recordRunSummary", () => {
  let tmp: string

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sysflow-usage-test-"))
  })

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true })
  })

  async function readEntries(): Promise<Array<Record<string, unknown>>> {
    const body = await fs.readFile(path.join(tmp, "usage.jsonl"), "utf8")
    return body.trim().split("\n").map((l) => JSON.parse(l))
  }

  it("persists Phase 10 chunkCount + flashCallsCount when set", async () => {
    await recordRunSummary(tmp, {
      runId: "r1",
      prompt: "build x",
      model: "openrouter-auto",
      durationMs: 1234,
      stepCount: 5,
      toolCount: 7,
      errorCount: 0,
      estimatedInputTokens: 100,
      estimatedOutputTokens: 200,
      terminalReason: "completed",
      chunkCount: 4,
      flashCallsCount: 9,
    })
    const [entry] = await readEntries()
    expect(entry.chunkCount).toBe(4)
    expect(entry.flashCallsCount).toBe(9)
  })

  it("defaults chunkCount + flashCallsCount to 0 when omitted (legacy run)", async () => {
    await recordRunSummary(tmp, {
      runId: "r2",
      prompt: "x",
      model: "openrouter-auto",
      durationMs: 1,
      stepCount: 0,
      toolCount: 0,
      errorCount: 0,
      estimatedInputTokens: 0,
      estimatedOutputTokens: 0,
      terminalReason: "completed",
    })
    const [entry] = await readEntries()
    expect(entry.chunkCount).toBe(0)
    expect(entry.flashCallsCount).toBe(0)
  })

  it("noop when sysbasePath is null/undefined", async () => {
    await recordRunSummary(null, {
      runId: "r3",
      prompt: "x",
      model: "x",
      durationMs: 0,
      stepCount: 0,
      toolCount: 0,
      errorCount: 0,
      estimatedInputTokens: 0,
      estimatedOutputTokens: 0,
      terminalReason: "completed",
    })
    // No throw, no file. We can't read tmp's usage.jsonl because it shouldn't exist.
    await expect(fs.access(path.join(tmp, "usage.jsonl"))).rejects.toThrow()
  })
})
