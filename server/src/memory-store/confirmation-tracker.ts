/**
 * Confirmation tracker — bumps useCount + lastConfirmedAt when a new
 * reasoning brief AGREES with an entry; bumps contradictionCount when
 * it disagrees. After 2 contradictions, status flips to 'contradicted'
 * and the entry stops being read into prompts forever.
 *
 * All three operations load the file, apply the change, and save.
 * They're best-effort — failures are logged, never thrown.
 */

import { loadMemoryEntries, saveMemoryEntries } from "./store.js"
import type { MemoryEntry } from "./entry-schema.js"

const CONTRADICTION_DEATH_THRESHOLD = 2

export async function noteAgreement(cwd: string, entryId: string): Promise<void> {
  await mutate(cwd, entryId, (e) => ({
    ...e,
    lastConfirmedAt: Date.now(),
    lastUsedAt: Date.now(),
    useCount: e.useCount + 1,
  }))
}

export async function noteContradiction(cwd: string, entryId: string): Promise<void> {
  await mutate(cwd, entryId, (e) => {
    const nextCount = e.contradictionCount + 1
    return {
      ...e,
      contradictionCount: nextCount,
      status: nextCount >= CONTRADICTION_DEATH_THRESHOLD ? "contradicted" as const : e.status,
      lastUsedAt: Date.now(),
    }
  })
}

export async function noteAccessed(cwd: string, entryId: string): Promise<void> {
  await mutate(cwd, entryId, (e) => ({ ...e, lastUsedAt: Date.now() }))
}

async function mutate(cwd: string, entryId: string, fn: (e: MemoryEntry) => MemoryEntry): Promise<void> {
  if (!cwd) return
  try {
    const entries = await loadMemoryEntries(cwd)
    const idx = entries.findIndex((e) => e.id === entryId)
    if (idx < 0) return  // unknown id — silently skip
    const next = [...entries]
    next[idx] = fn(entries[idx])
    await saveMemoryEntries(cwd, next)
  } catch (err) {
    console.warn(`[memory-store] confirmation update failed:`, (err as Error).message)
  }
}

export const _CONFIG = {
  CONTRADICTION_DEATH_THRESHOLD,
}
