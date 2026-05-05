/**
 * Read-time validators — anti-staleness is first-class.
 *
 * Every entry passes through these BEFORE it reaches the prompt:
 *   - validateFileRefs : every sourceRef.filePaths must exist on disk.
 *   - validateDepRefs  : every sourceRef.packageDeps must appear in
 *                        cwd's package.json (deps + devDeps + peerDeps).
 *   - validateAge      : entries unconfirmed for > STALE_AFTER_DAYS days
 *                        are stale (frequently-used entries get a longer
 *                        leash to STALE_AFTER_DAYS_HIGH_USE).
 *
 * Pure functions: no mutation. runAllValidators returns a partition AND
 * the entries with their status field updated to 'stale' where applicable.
 * Callers that want to persist the new statuses can write the updated
 * entries back; the prompt-injection path just uses the partition.
 */

import fs from "node:fs"
import path from "node:path"
import type { MemoryEntry } from "./entry-schema.js"

export interface ValidatorOptions {
  cwd: string
  nowMs?: number
  staleAfterDays?: number
  staleAfterDaysHighUse?: number
  highUseThreshold?: number
}

export interface ValidatedEntry extends MemoryEntry {
  /** Reasons this entry was marked stale, when applicable. */
  staleReasons?: string[]
}

const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_STALE_AFTER_DAYS = 60
const DEFAULT_STALE_AFTER_DAYS_HIGH_USE = 180
const DEFAULT_HIGH_USE_THRESHOLD = 5

export function validateFileRefs(entry: MemoryEntry, cwd: string): string[] {
  const reasons: string[] = []
  const refs = entry.sourceRef?.filePaths ?? []
  for (const rel of refs) {
    if (!rel || rel.startsWith("(")) continue
    const abs = path.isAbsolute(rel) ? rel : path.join(cwd, rel)
    if (!fs.existsSync(abs)) {
      reasons.push(`file-ref missing: ${rel}`)
    }
  }
  return reasons
}

export function validateDepRefs(entry: MemoryEntry, cwd: string): string[] {
  const reasons: string[] = []
  const refs = entry.sourceRef?.packageDeps ?? []
  if (refs.length === 0) return reasons

  let pkg: Record<string, unknown>
  try {
    const body = fs.readFileSync(path.join(cwd, "package.json"), "utf8")
    pkg = JSON.parse(body) as Record<string, unknown>
  } catch {
    // No package.json → can't verify deps. Don't penalise non-Node projects.
    return reasons
  }

  const allDeps = new Set([
    ...Object.keys((pkg.dependencies ?? {}) as Record<string, unknown>),
    ...Object.keys((pkg.devDependencies ?? {}) as Record<string, unknown>),
    ...Object.keys((pkg.peerDependencies ?? {}) as Record<string, unknown>),
    ...Object.keys((pkg.optionalDependencies ?? {}) as Record<string, unknown>),
  ])

  for (const dep of refs) {
    if (!dep) continue
    if (!allDeps.has(dep)) {
      reasons.push(`dep-ref missing: ${dep}`)
    }
  }
  return reasons
}

export function validateAge(entry: MemoryEntry, opts: ValidatorOptions): string[] {
  const nowMs = opts.nowMs ?? Date.now()
  const staleAfterDays = opts.staleAfterDays ?? DEFAULT_STALE_AFTER_DAYS
  const staleAfterDaysHighUse = opts.staleAfterDaysHighUse ?? DEFAULT_STALE_AFTER_DAYS_HIGH_USE
  const highUseThreshold = opts.highUseThreshold ?? DEFAULT_HIGH_USE_THRESHOLD

  const ageMs = nowMs - entry.lastConfirmedAt
  const limitDays = entry.useCount >= highUseThreshold ? staleAfterDaysHighUse : staleAfterDays
  const limitMs = limitDays * DAY_MS
  if (ageMs > limitMs) {
    return [`age: last confirmed ${Math.round(ageMs / DAY_MS)} days ago (limit ${limitDays})`]
  }
  return []
}

export interface PartitionResult {
  active: ValidatedEntry[]
  stale: ValidatedEntry[]
  contradicted: ValidatedEntry[]
}

export function runAllValidators(entries: MemoryEntry[], opts: ValidatorOptions): PartitionResult {
  const active: ValidatedEntry[] = []
  const stale: ValidatedEntry[] = []
  const contradicted: ValidatedEntry[] = []

  for (const e of entries) {
    if (e.status === "contradicted") {
      contradicted.push(e)
      continue
    }
    const reasons: string[] = [
      ...validateFileRefs(e, opts.cwd),
      ...validateDepRefs(e, opts.cwd),
      ...validateAge(e, opts),
    ]
    if (reasons.length > 0 || e.status === "stale") {
      stale.push({ ...e, status: "stale", staleReasons: reasons.length > 0 ? reasons : undefined })
    } else {
      active.push({ ...e })
    }
  }
  return { active, stale, contradicted }
}
