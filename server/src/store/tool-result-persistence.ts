/**
 * Disk-side archival of large tool results.
 *
 * The in-memory + DB representation of a tool result is already clamped by
 * applyToolResultBudget. This module archives the *original* (pre-budget)
 * result to <sysbasePath>/tool-results/<runId>/<toolId>.json so a human
 * (or a later debugging tool) can inspect what was actually returned —
 * even when the model only saw a truncated version.
 *
 * Pure I/O. Failures are logged and never thrown — archival is best-effort.
 */

import fs from "node:fs/promises"
import path from "node:path"
import { getFlag } from "../services/flags.js"

const FALLBACK_PERSISTENCE_THRESHOLD_BYTES = 10 * 1024  // 10 KiB
function persistenceThresholdBytes(): number {
  try {
    return getFlag<number>("tool.persist_threshold_bytes")
  } catch {
    return FALLBACK_PERSISTENCE_THRESHOLD_BYTES
  }
}

export interface PersistArgs {
  sysbasePath?: string | null
  runId: string
  toolId: string
  tool: string
  result: Record<string, unknown>
}

export interface PersistResult {
  /** Absolute path of the archived file, or null when nothing was archived. */
  path: string | null
  originalSize: number
}

/**
 * Archive `result` to disk if its serialised form exceeds the threshold.
 * Returns { path, originalSize } so the caller can attach a `_persistedPath`
 * field to the in-memory result that the model sees.
 */
export async function persistLargeToolResult(args: PersistArgs): Promise<PersistResult> {
  if (!args.sysbasePath) return { path: null, originalSize: 0 }

  let serialised: string
  try {
    serialised = JSON.stringify(args.result)
  } catch {
    return { path: null, originalSize: 0 }
  }
  const size = Buffer.byteLength(serialised, "utf8")
  if (size < persistenceThresholdBytes()) return { path: null, originalSize: size }

  const dir = path.join(args.sysbasePath, "tool-results", args.runId)
  const file = path.join(dir, `${args.toolId}.json`)

  try {
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(
      file,
      JSON.stringify({ tool: args.tool, runId: args.runId, toolId: args.toolId, savedAt: new Date().toISOString(), result: args.result }, null, 2),
      "utf8",
    )
    return { path: file, originalSize: size }
  } catch (err) {
    console.warn(`[tool-result-persist] Failed to archive ${args.tool}/${args.toolId}:`, (err as Error).message)
    return { path: null, originalSize: size }
  }
}

/**
 * Read back a persisted tool result. Used by future inspection commands —
 * not consumed by the agent loop directly.
 */
export async function loadPersistedToolResult(
  sysbasePath: string,
  runId: string,
  toolId: string,
): Promise<Record<string, unknown> | null> {
  try {
    const file = path.join(sysbasePath, "tool-results", runId, `${toolId}.json`)
    const body = await fs.readFile(file, "utf8")
    return JSON.parse(body)
  } catch {
    return null
  }
}
