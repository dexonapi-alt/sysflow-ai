/**
 * Daily-rotated JSONL audit log.
 *
 * Entries land in <sysbasePath>/audit-YYYY-MM-DD.jsonl (local timezone).
 * Once per day (the first call after the date changes vs. the last one
 * we wrote to), the directory is scanned and audit files older than
 * cli.audit_retention_days are deleted.
 *
 * Best-effort I/O: errors are logged once and never thrown. The agent
 * loop never blocks on the audit log.
 */

import fs from "node:fs/promises"
import path from "node:path"
import { getFlag } from "./flags.js"

const FILE_PREFIX = "audit-"
const FILE_SUFFIX = ".jsonl"
const FALLBACK_RETENTION_DAYS = 14

let lastDate: string | null = null

function todayKey(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const dd = String(d.getDate()).padStart(2, "0")
  return `${y}-${m}-${dd}`
}

function retentionDays(): number {
  try {
    return getFlag<number>("cli.audit_retention_days")
  } catch {
    return FALLBACK_RETENTION_DAYS
  }
}

export async function appendAudit(sysbasePath: string | undefined | null, entry: Record<string, unknown>): Promise<void> {
  if (!sysbasePath) return
  const dateKey = todayKey()
  const file = path.join(sysbasePath, `${FILE_PREFIX}${dateKey}${FILE_SUFFIX}`)

  try {
    if (lastDate !== dateKey) {
      lastDate = dateKey
      // First call of the day — best-effort cleanup of expired files.
      pruneOlderThan(sysbasePath, retentionDays()).catch(() => { /* best-effort */ })
    }
    await fs.appendFile(file, JSON.stringify(entry) + "\n", "utf8")
  } catch (err) {
    console.warn(`[audit-log] append failed:`, (err as Error).message)
  }
}

export async function pruneOlderThan(sysbasePath: string, days: number): Promise<number> {
  if (days <= 0) return 0
  let removed = 0
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000
  let entries: string[]
  try {
    entries = await fs.readdir(sysbasePath)
  } catch {
    return 0
  }
  for (const name of entries) {
    if (!name.startsWith(FILE_PREFIX) || !name.endsWith(FILE_SUFFIX)) continue
    const datePart = name.slice(FILE_PREFIX.length, name.length - FILE_SUFFIX.length)
    const parsed = Date.parse(datePart + "T00:00:00")
    if (Number.isNaN(parsed)) continue
    if (parsed < cutoffMs) {
      try {
        await fs.unlink(path.join(sysbasePath, name))
        removed += 1
      } catch { /* tolerate */ }
    }
  }
  return removed
}

export function _resetForTests(): void {
  lastDate = null
}
