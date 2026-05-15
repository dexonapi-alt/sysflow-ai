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

  // ─── Phase 11 Stage 6: awareness telemetry ───

  it("persists Phase 11 awareness telemetry when supplied", async () => {
    await recordRunSummary(tmp, {
      runId: "r-aw1",
      prompt: "build a postgres api",
      model: "openrouter-auto",
      durationMs: 5_000,
      stepCount: 8,
      toolCount: 12,
      errorCount: 1,
      estimatedInputTokens: 0,
      estimatedOutputTokens: 0,
      terminalReason: "completed",
      divergenceDetections: 2,
      divergenceConfidenceAvg: 78.456,
      autoPauseEvents: 1,
    })
    const [entry] = await readEntries()
    expect(entry.divergenceDetections).toBe(2)
    // Rounded to one decimal so the JSONL stays diff-friendly across runs.
    expect(entry.divergenceConfidenceAvg).toBe(78.5)
    expect(entry.autoPauseEvents).toBe(1)
  })

  it("defaults awareness telemetry to safe values when omitted (legacy + flag-off runs)", async () => {
    await recordRunSummary(tmp, {
      runId: "r-aw2",
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
    expect(entry.divergenceDetections).toBe(0)
    expect(entry.divergenceConfidenceAvg).toBeNull()
    expect(entry.autoPauseEvents).toBe(0)
  })

  // ─── Stage E of model-lock-and-portable-reasoning: reasonerBackend telemetry ───

  it("persists reasonerBackend when supplied", async () => {
    await recordRunSummary(tmp, {
      runId: "r-rb1",
      prompt: "build a thing",
      model: "claude-sonnet",
      durationMs: 1_000,
      stepCount: 3,
      toolCount: 4,
      errorCount: 0,
      estimatedInputTokens: 0,
      estimatedOutputTokens: 0,
      terminalReason: "completed",
      reasonerBackend: "anthropic",
    })
    const [entry] = await readEntries()
    expect(entry.reasonerBackend).toBe("anthropic")
  })

  it("emits reasonerBackend=null on legacy runs (field omitted)", async () => {
    await recordRunSummary(tmp, {
      runId: "r-rb2",
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
    expect(entry.reasonerBackend).toBeNull()
  })

  // ─── Stage 5 of command-first-investigation: investigationCommandsCount ───

  it("persists investigationCommandsCount when supplied", async () => {
    await recordRunSummary(tmp, {
      runId: "r-ic1",
      prompt: "fix the broken import",
      model: "openrouter-auto",
      durationMs: 4_000,
      stepCount: 6,
      toolCount: 8,
      errorCount: 0,
      estimatedInputTokens: 0,
      estimatedOutputTokens: 0,
      terminalReason: "completed",
      investigationCommandsCount: 3,
    })
    const [entry] = await readEntries()
    expect(entry.investigationCommandsCount).toBe(3)
  })

  it("defaults investigationCommandsCount to 0 when omitted", async () => {
    await recordRunSummary(tmp, {
      runId: "r-ic2",
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
    expect(entry.investigationCommandsCount).toBe(0)
  })

  it("preserves explicit reasonerBackend=null (no brief produced this run)", async () => {
    await recordRunSummary(tmp, {
      runId: "r-rb3",
      prompt: "x",
      model: "openrouter-auto",
      durationMs: 1,
      stepCount: 0,
      toolCount: 0,
      errorCount: 0,
      estimatedInputTokens: 0,
      estimatedOutputTokens: 0,
      terminalReason: "completed",
      reasonerBackend: null,
    })
    const [entry] = await readEntries()
    expect(entry.reasonerBackend).toBeNull()
  })

  // ─── Stage 5 of llm-iterative-intent-classification: intentClassificationSource ───

  it("persists intentClassificationSource when supplied", async () => {
    await recordRunSummary(tmp, {
      runId: "r-ic-src-1",
      prompt: "build a postgres-backed API",
      model: "openrouter-auto",
      durationMs: 1_000,
      stepCount: 1,
      toolCount: 1,
      errorCount: 0,
      estimatedInputTokens: 0,
      estimatedOutputTokens: 0,
      terminalReason: "completed",
      intentClassificationSource: "chain",
    })
    const [entry] = await readEntries()
    expect(entry.intentClassificationSource).toBe("chain")
  })

  it("persists each known intentClassificationSource value", async () => {
    for (const source of ["cache", "regex_simple", "regex_fallback", "chain"] as const) {
      await recordRunSummary(tmp, {
        runId: `r-ic-src-${source}`,
        prompt: "x",
        model: "openrouter-auto",
        durationMs: 1,
        stepCount: 0,
        toolCount: 0,
        errorCount: 0,
        estimatedInputTokens: 0,
        estimatedOutputTokens: 0,
        terminalReason: "completed",
        intentClassificationSource: source,
      })
    }
    const entries = await readEntries()
    expect(entries.map((e) => e.intentClassificationSource)).toEqual(["cache", "regex_simple", "regex_fallback", "chain"])
  })

  it("emits intentClassificationSource=null on legacy runs (field omitted)", async () => {
    await recordRunSummary(tmp, {
      runId: "r-ic-src-legacy",
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
    expect(entry.intentClassificationSource).toBeNull()
  })

  it("preserves explicit intentClassificationSource=null", async () => {
    await recordRunSummary(tmp, {
      runId: "r-ic-src-null",
      prompt: "x",
      model: "openrouter-auto",
      durationMs: 1,
      stepCount: 0,
      toolCount: 0,
      errorCount: 0,
      estimatedInputTokens: 0,
      estimatedOutputTokens: 0,
      terminalReason: "completed",
      intentClassificationSource: null,
    })
    const [entry] = await readEntries()
    expect(entry.intentClassificationSource).toBeNull()
  })

  it("emits divergenceConfidenceAvg=null when no snapshots were observed but other counters are present", async () => {
    await recordRunSummary(tmp, {
      runId: "r-aw3",
      prompt: "x",
      model: "openrouter-auto",
      durationMs: 1,
      stepCount: 0,
      toolCount: 0,
      errorCount: 0,
      estimatedInputTokens: 0,
      estimatedOutputTokens: 0,
      terminalReason: "completed",
      divergenceDetections: 0,
      autoPauseEvents: 0,
      // divergenceConfidenceAvg deliberately omitted — undefined ≠ 0,
      // because zero would be a valid sample.
    })
    const [entry] = await readEntries()
    expect(entry.divergenceConfidenceAvg).toBeNull()
  })
})
