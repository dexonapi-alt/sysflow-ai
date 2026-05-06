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
  }
  try {
    await fs.appendFile(file, JSON.stringify(entry) + "\n", "utf8")
  } catch (err) {
    console.warn(`[usage-log] append failed:`, (err as Error).message)
  }
}
