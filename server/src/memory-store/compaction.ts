/**
 * Compaction — drops entries when the file exceeds MEMORY_FILE_MAX_BYTES.
 *
 * Eviction order (least valuable first):
 *   1. contradicted
 *   2. stale (older first)
 *   3. low-useCount active (oldest first)
 *
 * NEVER drops user_correction entries. The user typed those explicitly;
 * we treat them as sacred. If a project ends up with so many user
 * corrections that they alone exceed the cap, the user can `/memory
 * forget <id>` themselves.
 */

import { loadMemoryEntries, saveMemoryEntries } from "./store.js"
import { serialiseEntries } from "./file-format.js"
import type { MemoryEntry } from "./entry-schema.js"

const DEFAULT_MAX_BYTES = 100 * 1024  // 100 KB

export interface CompactOptions {
  maxBytes?: number
}

export interface CompactResult {
  beforeBytes: number
  afterBytes: number
  removedIds: string[]
}

export async function compactIfNeeded(cwd: string, opts: CompactOptions = {}): Promise<CompactResult | null> {
  if (!cwd) return null
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
  const entries = await loadMemoryEntries(cwd)
  if (entries.length === 0) return null

  const beforeBytes = Buffer.byteLength(serialiseEntries(entries), "utf8")
  if (beforeBytes <= maxBytes) return null

  const sorted = [...entries].sort(evictionPriority)
  const removed: string[] = []

  // Drop one at a time until under cap (or only sacred entries remain).
  let working = [...entries]
  for (const candidate of sorted) {
    if (candidate.kind === "user_correction") break  // never drop user corrections
    const next = working.filter((e) => e.id !== candidate.id)
    const nextBytes = Buffer.byteLength(serialiseEntries(next), "utf8")
    working = next
    removed.push(candidate.id)
    if (nextBytes <= maxBytes) break
  }

  const afterBytes = Buffer.byteLength(serialiseEntries(working), "utf8")
  await saveMemoryEntries(cwd, working)
  console.log(`[memory-store] compacted: ${beforeBytes}B → ${afterBytes}B; dropped ${removed.length} entries`)
  return { beforeBytes, afterBytes, removedIds: removed }
}

/**
 * Sort comparator: lower priority entries come FIRST (so they're
 * evicted first).
 */
function evictionPriority(a: MemoryEntry, b: MemoryEntry): number {
  const score = (e: MemoryEntry): number => {
    let s = 0
    if (e.status === "contradicted") s -= 1_000_000        // evict first
    if (e.status === "stale") s -= 500_000
    s += e.useCount * 1000                                  // useful entries survive
    s += Math.floor(e.lastUsedAt / 86_400_000)              // recency in days
    if (e.kind === "user_correction") s += 10_000_000        // sacred — push to the end
    return s
  }
  return score(a) - score(b)
}

export const _CONFIG = {
  DEFAULT_MAX_BYTES,
}
