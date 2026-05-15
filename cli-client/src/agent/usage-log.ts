/**
 * Per-run usage telemetry. One JSONL line per terminal exit (success or
 * failure) appended to <sysbasePath>/usage.jsonl. Entries include just enough
 * to debug a session retroactively without leaking the user's full prompt.
 *
 * Best-effort I/O; never throws.
 */

import fs from "node:fs/promises"
import path from "node:path"

export interface RunSummary {
  runId: string | null
  prompt: string
  model: string
  durationMs: number
  stepCount: number
  toolCount: number
  errorCount: number
  estimatedInputTokens: number
  estimatedOutputTokens: number
  /** Terminal reason from the state machine (e.g. 'completed', 'failed', 'session_expired'). */
  terminalReason: string
  /** Phase 7: number of background jobs started during this run. */
  backgroundJobsRun?: number
  /** Phase 7: number of background jobs that ended in 'failed' status. */
  backgroundJobsFailed?: number
  /** Phase 10: how many chunks the planner emitted during this run. */
  chunkCount?: number
  /** Phase 10: count of successful Gemini Flash returns we OBSERVED on the
   *  client (preflight + chunk_plan + chunk_reflect). Approximate — failed
   *  Flash calls don't produce briefs and aren't counted. */
  flashCallsCount?: number
  /** Phase 11 Stage 6: how many response snapshots arrived with confidence
   *  below 100 (i.e. the awareness loop fired at least one signal that turn).
   *  A coarse "did the detector even notice anything?" signal. */
  divergenceDetections?: number
  /** Phase 11 Stage 6: mean confidence across every awareness snapshot we
   *  observed during the run. Drift indicator — runs that hit ~85 average
   *  are within normal noise; runs averaging <60 should get manual review. */
  divergenceConfidenceAvg?: number
  /** Phase 11 Stage 6: how many times the off-course modal was actually
   *  shown to the user this run (response carried `awarenessChoice: true`).
   *  Target ≤ 0.1/run on aggregate; spikes mean the thresholds need tuning
   *  or the model genuinely went off the rails. */
  autoPauseEvents?: number
  /** Stage E of model-lock-and-portable-reasoning: which reasoner
   *  backend served the run's Flash calls (`"gemini"` / `"anthropic"`
   *  / `"openrouter"`). Captured from the server's first response that
   *  carries `reasonerBackend`. Null on runs where no brief was
   *  produced (legacy fallback, or no API keys configured). Lets
   *  telemetry analysis split metrics by backend so the cost +
   *  reliability of each path can be tracked separately. */
  reasonerBackend?: "gemini" | "anthropic" | "openrouter" | null
  /** Stage 5 of command-first-investigation: count of safe-read-only
   *  `run_command` calls the agent dispatched during the run. Counted
   *  at CLI dispatch time via `isSafeReadOnlyCommand` so denied / failed
   *  commands still register — the metric measures the agent's intent
   *  to investigate, not its success rate. Target trend after this
   *  plan: ≥ 2 for non-trivial implement/bug runs, ~0 for trivial
   *  one-line fixes (the LLM should skip investigation for obvious work). */
  investigationCommandsCount?: number
  /** Stage 5 of llm-iterative-intent-classification: which
   *  classification path resolved the run's intent. See
   *  `server/src/types.ts: ClientResponse.intentClassificationSource`
   *  for the value semantics. Captured on the first response that
   *  carries it (constant for the run); null on legacy runs where
   *  the server hasn't shipped the field yet. */
  intentClassificationSource?: "cache" | "regex_simple" | "regex_fallback" | "chain" | null
  /** Stage 3 of forced-error-reasoning plan: which error-reasoning
   *  path resolved the run's most-recent error.
   *    `"chain"`         — LLM iterative chain committed.
   *    `"bug_fallback"`  — chain returned null; existing on-error
   *                        bug pipeline (Phase 5) produced the brief.
   *    `null`            — no error fired this run, OR the run is
   *                        from before this telemetry field shipped. */
  errorReasoningSource?: "chain" | "bug_fallback" | null
  /** Stage 6 of forced-error-reasoning plan: per-run count of error-
   *  reasoning chain invocations. Each tool error that fires the
   *  chain (whether the chain commits or falls back) increments this.
   *  Defaults to 0 on runs without errors so jq distributions don't
   *  need a null check. */
  errorReasoningEvents?: number
  /** Stage 6: peak per-run count of Stage 4 error-acknowledgement
   *  rejections. Reflects how often the model needed a stronger
   *  reject-prompt to engage with a prior tool error. Capped at
   *  `MAX_ERROR_ACK_REJECTIONS` (3) per error; sustained high values
   *  here on free-tier runs suggest the Stage 3 inject block isn't
   *  carrying enough weight. Defaults to 0. */
  errorAcknowledgementRejections?: number
}

const PROMPT_PREVIEW_CHARS = 200

export async function recordRunSummary(sysbasePath: string | undefined | null, summary: RunSummary): Promise<void> {
  if (!sysbasePath) return
  const file = path.join(sysbasePath, "usage.jsonl")
  const entry = {
    ts: new Date().toISOString(),
    runId: summary.runId,
    prompt: (summary.prompt || "").slice(0, PROMPT_PREVIEW_CHARS),
    model: summary.model,
    durationMs: summary.durationMs,
    stepCount: summary.stepCount,
    toolCount: summary.toolCount,
    errorCount: summary.errorCount,
    estimatedInputTokens: summary.estimatedInputTokens,
    estimatedOutputTokens: summary.estimatedOutputTokens,
    terminalReason: summary.terminalReason,
    backgroundJobsRun: summary.backgroundJobsRun ?? 0,
    backgroundJobsFailed: summary.backgroundJobsFailed ?? 0,
    chunkCount: summary.chunkCount ?? 0,
    flashCallsCount: summary.flashCallsCount ?? 0,
    divergenceDetections: summary.divergenceDetections ?? 0,
    // null sentinel when no awareness snapshots were observed (awareness
    // disabled, or run terminated before any chunked-loop response landed).
    divergenceConfidenceAvg: typeof summary.divergenceConfidenceAvg === "number"
      ? Math.round(summary.divergenceConfidenceAvg * 10) / 10
      : null,
    autoPauseEvents: summary.autoPauseEvents ?? 0,
    // Stage E of model-lock-and-portable-reasoning. Null sentinel when
    // no brief landed during the run (legacy fallback path) so jq /
    // analysis tools can distinguish "no reasoning happened" from "no
    // such field was logged".
    reasonerBackend: summary.reasonerBackend ?? null,
    // Stage 5 of command-first-investigation. Defaults to 0 (omitted
    // → no investigation observed) since the cli always counts when
    // the field flows.
    investigationCommandsCount: summary.investigationCommandsCount ?? 0,
    // Stage 5 of llm-iterative-intent-classification. Null sentinel
    // on runs where the server didn't ship the field (legacy or pre-
    // Stage-4) so jq / analysis tools can distinguish "no signal"
    // from "field not logged".
    intentClassificationSource: summary.intentClassificationSource ?? null,
    // Stage 3 of forced-error-reasoning plan. Null sentinel on runs
    // where no error fired (most runs) so the distribution of `chain`
    // vs `bug_fallback` is countable.
    errorReasoningSource: summary.errorReasoningSource ?? null,
    // Stage 6 of forced-error-reasoning plan. Defaults to 0 (omitted
    // → no error reasoner fired this run) since a chain invocation
    // always increments client-side when observed.
    errorReasoningEvents: summary.errorReasoningEvents ?? 0,
    errorAcknowledgementRejections: summary.errorAcknowledgementRejections ?? 0,
  }
  try {
    await fs.appendFile(file, JSON.stringify(entry) + "\n", "utf8")
  } catch (err) {
    console.warn(`[usage-log] append failed:`, (err as Error).message)
  }
}
