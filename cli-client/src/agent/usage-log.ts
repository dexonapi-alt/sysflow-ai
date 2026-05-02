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
  }
  try {
    await fs.appendFile(file, JSON.stringify(entry) + "\n", "utf8")
  } catch (err) {
    console.warn(`[usage-log] append failed:`, (err as Error).message)
  }
}
