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

  // ─── Stage 3 of forced-error-reasoning-and-recovery: errorReasoningSource ───

  it("persists errorReasoningSource when chain committed", async () => {
    await recordRunSummary(tmp, {
      runId: "r-er-1",
      prompt: "build a thing",
      model: "openrouter-auto",
      durationMs: 1_000,
      stepCount: 5,
      toolCount: 8,
      errorCount: 1,
      estimatedInputTokens: 0,
      estimatedOutputTokens: 0,
      terminalReason: "completed",
      errorReasoningSource: "chain",
    })
    const [entry] = await readEntries()
    expect(entry.errorReasoningSource).toBe("chain")
  })

  it("persists errorReasoningSource=bug_fallback", async () => {
    await recordRunSummary(tmp, {
      runId: "r-er-2",
      prompt: "x",
      model: "openrouter-auto",
      durationMs: 1,
      stepCount: 0,
      toolCount: 0,
      errorCount: 1,
      estimatedInputTokens: 0,
      estimatedOutputTokens: 0,
      terminalReason: "completed",
      errorReasoningSource: "bug_fallback",
    })
    const [entry] = await readEntries()
    expect(entry.errorReasoningSource).toBe("bug_fallback")
  })

  it("emits errorReasoningSource=null on runs without errors", async () => {
    await recordRunSummary(tmp, {
      runId: "r-er-3",
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
    expect(entry.errorReasoningSource).toBeNull()
  })

  // ─── Stage 6 of forced-error-reasoning-and-recovery: per-run counters ───

  it("persists errorReasoningEvents + errorAcknowledgementRejections when supplied", async () => {
    await recordRunSummary(tmp, {
      runId: "r-er6-1",
      prompt: "x",
      model: "openrouter-auto",
      durationMs: 1_000,
      stepCount: 4,
      toolCount: 6,
      errorCount: 2,
      estimatedInputTokens: 0,
      estimatedOutputTokens: 0,
      terminalReason: "completed",
      errorReasoningSource: "chain",
      errorReasoningEvents: 2,
      errorAcknowledgementRejections: 1,
    })
    const [entry] = await readEntries()
    expect(entry.errorReasoningEvents).toBe(2)
    expect(entry.errorAcknowledgementRejections).toBe(1)
  })

  it("defaults errorReasoningEvents + errorAcknowledgementRejections to 0 when omitted", async () => {
    await recordRunSummary(tmp, {
      runId: "r-er6-2",
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
    expect(entry.errorReasoningEvents).toBe(0)
    expect(entry.errorAcknowledgementRejections).toBe(0)
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

  // ─── Stage 5 of agent-runtime-fixes plan: project-init + 0-hit + peek expansion telemetry ───

  it("persists projectInitRepoState + projectInitConfidence when supplied", async () => {
    await recordRunSummary(tmp, {
      runId: "r-pi-1",
      prompt: "build a node API",
      model: "openrouter-auto",
      durationMs: 1_500,
      stepCount: 3,
      toolCount: 5,
      errorCount: 0,
      estimatedInputTokens: 0,
      estimatedOutputTokens: 0,
      terminalReason: "completed",
      projectInitRepoState: "empty",
      projectInitConfidence: "HIGH",
    })
    const [entry] = await readEntries()
    expect(entry.projectInitRepoState).toBe("empty")
    expect(entry.projectInitConfidence).toBe("HIGH")
  })

  it("persists each known projectInitRepoState value", async () => {
    for (const state of ["empty", "small", "existing-small", "existing-large"] as const) {
      await recordRunSummary(tmp, {
        runId: `r-pi-${state}`,
        prompt: "x",
        model: "openrouter-auto",
        durationMs: 1,
        stepCount: 0,
        toolCount: 0,
        errorCount: 0,
        estimatedInputTokens: 0,
        estimatedOutputTokens: 0,
        terminalReason: "completed",
        projectInitRepoState: state,
        projectInitConfidence: "MEDIUM",
      })
    }
    const entries = await readEntries()
    expect(entries.map((e) => e.projectInitRepoState)).toEqual(["empty", "small", "existing-small", "existing-large"])
  })

  it("emits projectInitRepoState=null on legacy runs (field omitted)", async () => {
    await recordRunSummary(tmp, {
      runId: "r-pi-legacy",
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
    expect(entry.projectInitRepoState).toBeNull()
    expect(entry.projectInitConfidence).toBeNull()
  })

  it("persists webSearchEmptyCount + reasoningPeekExpansions when supplied", async () => {
    await recordRunSummary(tmp, {
      runId: "r-ts-1",
      prompt: "x",
      model: "openrouter-auto",
      durationMs: 1_000,
      stepCount: 4,
      toolCount: 6,
      errorCount: 0,
      estimatedInputTokens: 0,
      estimatedOutputTokens: 0,
      terminalReason: "completed",
      webSearchEmptyCount: 2,
      reasoningPeekExpansions: 5,
    })
    const [entry] = await readEntries()
    expect(entry.webSearchEmptyCount).toBe(2)
    expect(entry.reasoningPeekExpansions).toBe(5)
  })

  it("defaults webSearchEmptyCount + reasoningPeekExpansions to 0 when omitted", async () => {
    await recordRunSummary(tmp, {
      runId: "r-ts-2",
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
    expect(entry.webSearchEmptyCount).toBe(0)
    expect(entry.reasoningPeekExpansions).toBe(0)
  })

  // ─── Stage 4 of reasoning-chain-provider-parity plan: structured-vs-synthesised distribution ───

  it("persists reasoningChainEmittedTurns + reasoningChainSynthesisedTurns when supplied", async () => {
    await recordRunSummary(tmp, {
      runId: "r-rcpp-1",
      prompt: "x",
      model: "openrouter-auto",
      durationMs: 1_500,
      stepCount: 8,
      toolCount: 12,
      errorCount: 0,
      estimatedInputTokens: 0,
      estimatedOutputTokens: 0,
      terminalReason: "completed",
      reasoningChainEmittedTurns: 7,
      reasoningChainSynthesisedTurns: 5,
    })
    const [entry] = await readEntries()
    expect(entry.reasoningChainEmittedTurns).toBe(7)
    expect(entry.reasoningChainSynthesisedTurns).toBe(5)
  })

  it("defaults reasoningChainEmittedTurns + reasoningChainSynthesisedTurns to 0 when omitted", async () => {
    await recordRunSummary(tmp, {
      runId: "r-rcpp-2",
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
    expect(entry.reasoningChainEmittedTurns).toBe(0)
    expect(entry.reasoningChainSynthesisedTurns).toBe(0)
  })

  it("preserves a structured-only run (synthesised=0)", async () => {
    await recordRunSummary(tmp, {
      runId: "r-rcpp-3",
      prompt: "x",
      model: "claude-sonnet",
      durationMs: 1_000,
      stepCount: 5,
      toolCount: 8,
      errorCount: 0,
      estimatedInputTokens: 0,
      estimatedOutputTokens: 0,
      terminalReason: "completed",
      reasoningChainEmittedTurns: 10,
      reasoningChainSynthesisedTurns: 0,
    })
    const [entry] = await readEntries()
    expect(entry.reasoningChainEmittedTurns).toBe(10)
    expect(entry.reasoningChainSynthesisedTurns).toBe(0)
  })

  // ─── Stage 5 of server-hardening plan: sysflow-infra + null-tool + non-retryable-5xx telemetry ───

  it("persists sysflowInfraErrorCount + nullToolRejectionCount + nonRetryable5xxCount when supplied", async () => {
    await recordRunSummary(tmp, {
      runId: "r-shd-1",
      prompt: "x",
      model: "openrouter-auto",
      durationMs: 1_500,
      stepCount: 4,
      toolCount: 6,
      errorCount: 1,
      estimatedInputTokens: 0,
      estimatedOutputTokens: 0,
      terminalReason: "sysflow_infra",
      sysflowInfraErrorCount: 1,
      nullToolRejectionCount: 2,
      nonRetryable5xxCount: 1,
    })
    const [entry] = await readEntries()
    expect(entry.sysflowInfraErrorCount).toBe(1)
    expect(entry.nullToolRejectionCount).toBe(2)
    expect(entry.nonRetryable5xxCount).toBe(1)
  })

  it("defaults all three counters to 0 when omitted (legacy run)", async () => {
    await recordRunSummary(tmp, {
      runId: "r-shd-2",
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
    expect(entry.sysflowInfraErrorCount).toBe(0)
    expect(entry.nullToolRejectionCount).toBe(0)
    expect(entry.nonRetryable5xxCount).toBe(0)
  })

  it("clean run keeps all three counters at 0 (the common case)", async () => {
    await recordRunSummary(tmp, {
      runId: "r-shd-3",
      prompt: "x",
      model: "claude-sonnet",
      durationMs: 5_000,
      stepCount: 8,
      toolCount: 12,
      errorCount: 0,
      estimatedInputTokens: 0,
      estimatedOutputTokens: 0,
      terminalReason: "completed",
      sysflowInfraErrorCount: 0,
      nullToolRejectionCount: 0,
      nonRetryable5xxCount: 0,
    })
    const [entry] = await readEntries()
    expect(entry.sysflowInfraErrorCount).toBe(0)
    expect(entry.nullToolRejectionCount).toBe(0)
    expect(entry.nonRetryable5xxCount).toBe(0)
  })

  // ─── Stage 5 of code-correctness plan: tsc + sanitizer + artifact gate telemetry ───

  it("persists importsStrippedCount + tscErrorCount + completionBlockedReason when supplied", async () => {
    await recordRunSummary(tmp, {
      runId: "r-cc5-1",
      prompt: "build a PG backend",
      model: "openrouter-auto",
      durationMs: 5_000,
      stepCount: 8,
      toolCount: 15,
      errorCount: 0,
      estimatedInputTokens: 0,
      estimatedOutputTokens: 0,
      terminalReason: "completed",
      importsStrippedCount: 5,
      tscErrorCount: 3,
      completionBlockedReason: "tsc",
    })
    const [entry] = await readEntries()
    expect(entry.importsStrippedCount).toBe(5)
    expect(entry.tscErrorCount).toBe(3)
    expect(entry.completionBlockedReason).toBe("tsc")
  })

  it("defaults code-correctness counters appropriately when omitted", async () => {
    await recordRunSummary(tmp, {
      runId: "r-cc5-2",
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
    expect(entry.importsStrippedCount).toBe(0)
    expect(entry.tscErrorCount).toBe(0)
    expect(entry.completionBlockedReason).toBeNull()
  })

  it("persists completionBlockedReason: artifact_missing", async () => {
    await recordRunSummary(tmp, {
      runId: "r-cc5-3",
      prompt: "build a PG backend",
      model: "openrouter-auto",
      durationMs: 5_000,
      stepCount: 6,
      toolCount: 10,
      errorCount: 0,
      estimatedInputTokens: 0,
      estimatedOutputTokens: 0,
      terminalReason: "completed",
      completionBlockedReason: "artifact_missing",
    })
    const [entry] = await readEntries()
    expect(entry.completionBlockedReason).toBe("artifact_missing")
  })

  it("clean run with no gate firing keeps tscErrorCount=0 and completionBlockedReason=null", async () => {
    await recordRunSummary(tmp, {
      runId: "r-cc5-4",
      prompt: "build a CLI",
      model: "claude-sonnet",
      durationMs: 3_000,
      stepCount: 5,
      toolCount: 8,
      errorCount: 0,
      estimatedInputTokens: 0,
      estimatedOutputTokens: 0,
      terminalReason: "completed",
      importsStrippedCount: 0,
      tscErrorCount: 0,
      completionBlockedReason: null,
    })
    const [entry] = await readEntries()
    expect(entry.tscErrorCount).toBe(0)
    expect(entry.completionBlockedReason).toBeNull()
  })

  // ─── Stage 5 of awareness-and-verification-correctness plan ───

  it("persists Stage 5 awareness telemetry: dotfile / intent-match / modal-shown / win-shell-errors", async () => {
    await recordRunSummary(tmp, {
      runId: "r-awareness-5-1",
      prompt: "build a POS PG backend",
      model: "openrouter-auto",
      durationMs: 12_000,
      stepCount: 20,
      toolCount: 25,
      errorCount: 0,
      estimatedInputTokens: 0,
      estimatedOutputTokens: 0,
      terminalReason: "completed",
      dotfileFilterCorrections: 3,
      intentKeywordContentMatches: 4,
      awarenessModalShown: true,
      windowsShellErrorsCaught: 2,
    })
    const [entry] = await readEntries()
    expect(entry.dotfileFilterCorrections).toBe(3)
    expect(entry.intentKeywordContentMatches).toBe(4)
    expect(entry.awarenessModalShown).toBe(true)
    expect(entry.windowsShellErrorsCaught).toBe(2)
  })

  it("defaults Stage 5 awareness telemetry to 0 / false when omitted (legacy run)", async () => {
    await recordRunSummary(tmp, {
      runId: "r-awareness-5-2",
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
    expect(entry.dotfileFilterCorrections).toBe(0)
    expect(entry.intentKeywordContentMatches).toBe(0)
    expect(entry.awarenessModalShown).toBe(false)
    expect(entry.windowsShellErrorsCaught).toBe(0)
  })

  it("persists awarenessModalShown=false explicitly on a clean run", async () => {
    await recordRunSummary(tmp, {
      runId: "r-awareness-5-3",
      prompt: "build x",
      model: "openrouter-auto",
      durationMs: 5_000,
      stepCount: 8,
      toolCount: 10,
      errorCount: 0,
      estimatedInputTokens: 0,
      estimatedOutputTokens: 0,
      terminalReason: "completed",
      awarenessModalShown: false,
    })
    const [entry] = await readEntries()
    expect(entry.awarenessModalShown).toBe(false)
  })

  // ─── Stage 6 of accountability-and-parallel-execution-sequencing plan ───

  it("persists Stage 6 accountability telemetry: maxBatchSize / batchCapEnforced / reorderedBatch / alreadyCreated / insufficientReasoning", async () => {
    await recordRunSummary(tmp, {
      runId: "r-accountability-6-1",
      prompt: "build a fastify backend",
      model: "openrouter-auto",
      durationMs: 18_000,
      stepCount: 12,
      toolCount: 15,
      errorCount: 0,
      estimatedInputTokens: 0,
      estimatedOutputTokens: 0,
      terminalReason: "completed",
      maxBatchSize: 11,
      batchCapEnforcedCount: 3,
      reorderedBatchCount: 1,
      alreadyCreatedRejectionCount: 1,
      insufficientReasoningRejectionCount: 2,
    })
    const [entry] = await readEntries()
    expect(entry.maxBatchSize).toBe(11)
    expect(entry.batchCapEnforcedCount).toBe(3)
    expect(entry.reorderedBatchCount).toBe(1)
    expect(entry.alreadyCreatedRejectionCount).toBe(1)
    expect(entry.insufficientReasoningRejectionCount).toBe(2)
  })

  it("defaults Stage 6 accountability telemetry to 0 when omitted (legacy run)", async () => {
    await recordRunSummary(tmp, {
      runId: "r-accountability-6-2",
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
    expect(entry.maxBatchSize).toBe(0)
    expect(entry.batchCapEnforcedCount).toBe(0)
    expect(entry.reorderedBatchCount).toBe(0)
    expect(entry.alreadyCreatedRejectionCount).toBe(0)
    expect(entry.insufficientReasoningRejectionCount).toBe(0)
  })

  it("persists a clean run with all Stage 6 gate counters at 0 (no oversized batches)", async () => {
    await recordRunSummary(tmp, {
      runId: "r-accountability-6-3",
      prompt: "fix a typo",
      model: "claude-sonnet",
      durationMs: 1_500,
      stepCount: 2,
      toolCount: 1,
      errorCount: 0,
      estimatedInputTokens: 0,
      estimatedOutputTokens: 0,
      terminalReason: "completed",
      maxBatchSize: 1,
      batchCapEnforcedCount: 0,
      reorderedBatchCount: 0,
      alreadyCreatedRejectionCount: 0,
      insufficientReasoningRejectionCount: 0,
    })
    const [entry] = await readEntries()
    expect(entry.maxBatchSize).toBe(1)
    expect(entry.batchCapEnforcedCount).toBe(0)
  })

  // ─── Stage 6 of plan 2026-05-18-ui-ux-polish-and-action-aware-spinner.md ───

  it("persists Stage 6 ui-ux telemetry: scroll-glitch / spinner-action / stream-preview / infra-banner / permission-modal", async () => {
    await recordRunSummary(tmp, {
      runId: "r-ui-ux-6-1",
      prompt: "scaffold a backend",
      model: "openrouter-auto",
      durationMs: 30_000,
      stepCount: 12,
      toolCount: 14,
      errorCount: 0,
      estimatedInputTokens: 0,
      estimatedOutputTokens: 0,
      terminalReason: "completed",
      scrollGlitchPauseFiredCount: 2,
      spinnerActionLabelFired: true,
      streamPreviewEverShown: true,
      infraErrorBannerShown: false,
      permissionModalShownCount: 3,
    })
    const [entry] = await readEntries()
    expect(entry.scrollGlitchPauseFiredCount).toBe(2)
    expect(entry.spinnerActionLabelFired).toBe(true)
    expect(entry.streamPreviewEverShown).toBe(true)
    expect(entry.infraErrorBannerShown).toBe(false)
    expect(entry.permissionModalShownCount).toBe(3)
  })

  it("defaults Stage 6 ui-ux telemetry to 0 / false when omitted (legacy run)", async () => {
    await recordRunSummary(tmp, {
      runId: "r-ui-ux-6-2",
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
    expect(entry.scrollGlitchPauseFiredCount).toBe(0)
    expect(entry.spinnerActionLabelFired).toBe(false)
    expect(entry.streamPreviewEverShown).toBe(false)
    expect(entry.infraErrorBannerShown).toBe(false)
    expect(entry.permissionModalShownCount).toBe(0)
  })

  it("persists infra-banner latched true on a sysflow_infra run", async () => {
    await recordRunSummary(tmp, {
      runId: "r-ui-ux-6-3",
      prompt: "...",
      model: "openrouter-auto",
      durationMs: 500,
      stepCount: 0,
      toolCount: 0,
      errorCount: 1,
      estimatedInputTokens: 0,
      estimatedOutputTokens: 0,
      terminalReason: "sysflow_infra",
      infraErrorBannerShown: true,
    })
    const [entry] = await readEntries()
    expect(entry.infraErrorBannerShown).toBe(true)
    expect(entry.terminalReason).toBe("sysflow_infra")
  })
})
