/**
 * Chat input history. Persisted to <sysbasePath>/chat-history.jsonl as
 * one entry per line so the file stays appendable without parsing the
 * whole thing on each write.
 */

import fs from "node:fs/promises"
import path from "node:path"

const HISTORY_FILE = "chat-history.jsonl"
const MAX_HISTORY = 100

interface HistoryEntry {
  prompt: string
  ts: number
}

export async function loadHistory(sysbasePath: string | null | undefined): Promise<string[]> {
  if (!sysbasePath) return []
  try {
    const body = await fs.readFile(path.join(sysbasePath, HISTORY_FILE), "utf8")
    const lines = body.split("\n").filter(Boolean)
    const entries: HistoryEntry[] = []
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as HistoryEntry
        if (typeof entry.prompt === "string") entries.push(entry)
      } catch { /* skip malformed */ }
    }
    return entries.slice(-MAX_HISTORY).map((e) => e.prompt)
  } catch {
    return []
  }
}

export async function appendHistory(sysbasePath: string | null | undefined, prompt: string): Promise<void> {
  if (!sysbasePath) return
  if (!prompt.trim()) return
  try {
    await fs.mkdir(sysbasePath, { recursive: true })
    const entry: HistoryEntry = { prompt, ts: Date.now() }
    await fs.appendFile(path.join(sysbasePath, HISTORY_FILE), JSON.stringify(entry) + "\n", "utf8")

    // Keep file bounded — prune to MAX_HISTORY when it gets too long.
    // (Done occasionally rather than on every write to avoid the rewrite cost.)
    const stat = await fs.stat(path.join(sysbasePath, HISTORY_FILE))
    if (stat.size > 200 * 1024) {  // 200 KiB ≈ several thousand entries
      const recent = await loadHistory(sysbasePath)
      const lines = recent.map((p) => JSON.stringify({ prompt: p, ts: Date.now() })).join("\n") + "\n"
      await fs.writeFile(path.join(sysbasePath, HISTORY_FILE), lines, "utf8")
    }
  } catch { /* best-effort */ }
}
