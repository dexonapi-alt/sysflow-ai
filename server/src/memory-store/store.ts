/**
 * Memory store — load/save/upsert for `<cwd>/.sysflow-memory.md`.
 *
 * Reads are mtime-cached (same pattern as project-memory.ts). Writes are
 * atomic via temp file + rename so concurrent CLI runs can't tear the file.
 *
 * Discovery walks up to ONE parent directory (consistent with the project
 * memory module) so a sub-folder of a project still finds the root memory.
 */

import fs from "node:fs/promises"
import fsSync from "node:fs"
import path from "node:path"
import os from "node:os"
import crypto from "node:crypto"
import { serialiseEntries, parseEntries } from "./file-format.js"
import { entryId, type MemoryEntry, type NewEntryInput, makeEntry } from "./entry-schema.js"

const MEMORY_FILE_NAME = ".sysflow-memory.md"

interface CacheEntry {
  path: string
  mtimeMs: number
  entries: MemoryEntry[]
}

const cache = new Map<string, CacheEntry>()

/** Return the absolute path Sysflow would write/read for the given cwd. */
export function memoryPathFor(cwd: string): string {
  return path.join(cwd, MEMORY_FILE_NAME)
}

/**
 * Discover the memory file: cwd first, then one parent up. Returns the
 * absolute path that exists, or the cwd path (the canonical write target)
 * when neither exists.
 */
function discoverMemoryPath(cwd: string): string {
  const cwdPath = memoryPathFor(cwd)
  if (fsSync.existsSync(cwdPath)) return cwdPath
  const parentPath = memoryPathFor(path.dirname(cwd))
  if (fsSync.existsSync(parentPath)) return parentPath
  return cwdPath
}

export async function loadMemoryEntries(cwd: string | null | undefined): Promise<MemoryEntry[]> {
  if (!cwd) return []
  const filePath = discoverMemoryPath(cwd)
  let mtimeMs = 0
  try {
    const stat = await fs.stat(filePath)
    mtimeMs = stat.mtimeMs
  } catch {
    return []  // file doesn't exist → empty memory
  }
  const cached = cache.get(filePath)
  if (cached && cached.mtimeMs === mtimeMs) return cached.entries

  let body: string
  try {
    body = await fs.readFile(filePath, "utf8")
  } catch {
    return []
  }
  const { entries, skipped } = parseEntries(body)
  if (skipped > 0) {
    console.warn(`[memory-store] skipped ${skipped} malformed entries in ${filePath}`)
  }
  cache.set(filePath, { path: filePath, mtimeMs, entries })
  return entries
}

/**
 * Atomic write: serialise → write temp → rename. Updates the cache after
 * the rename so subsequent reads skip the disk hit.
 */
export async function saveMemoryEntries(cwd: string, entries: MemoryEntry[]): Promise<void> {
  if (!cwd) return
  const filePath = memoryPathFor(cwd)
  const dir = path.dirname(filePath)
  const tempName = `.sysflow-memory.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`
  const tempPath = path.join(dir, tempName)
  const body = serialiseEntries(entries)

  try {
    await fs.writeFile(tempPath, body, "utf8")
    await fs.rename(tempPath, filePath)
  } catch (err) {
    // On Windows the rename can fail if the target is locked — best-effort
    // retry once with a short delay; if still failing, surface a warning
    // and clean up the temp file.
    if ((err as NodeJS.ErrnoException).code === "EPERM" || (err as NodeJS.ErrnoException).code === "EBUSY") {
      await new Promise((r) => setTimeout(r, 100))
      try {
        await fs.rename(tempPath, filePath)
      } catch (retryErr) {
        console.warn(`[memory-store] write failed (retry): ${(retryErr as Error).message}`)
        try { await fs.unlink(tempPath) } catch { /* ignore */ }
        return
      }
    } else {
      console.warn(`[memory-store] write failed: ${(err as Error).message}`)
      try { await fs.unlink(tempPath) } catch { /* ignore */ }
      return
    }
  }

  // Refresh cache.
  try {
    const stat = await fs.stat(filePath)
    cache.set(filePath, { path: filePath, mtimeMs: stat.mtimeMs, entries })
  } catch {
    // Cache will rebuild on next read.
  }
}

/**
 * Insert-or-update an entry. Dedupe is by id (sha256 of kind+content) —
 * if an entry with the same id exists, refresh its timestamps + counters
 * instead of writing a duplicate.
 */
export async function upsertEntry(cwd: string, input: NewEntryInput): Promise<MemoryEntry> {
  const entries = await loadMemoryEntries(cwd)
  const id = entryId(input.kind, input.content)
  const nowMs = Date.now()
  const existing = entries.find((e) => e.id === id)

  let updated: MemoryEntry
  let nextEntries: MemoryEntry[]
  if (existing) {
    updated = {
      ...existing,
      lastConfirmedAt: nowMs,
      lastUsedAt: nowMs,
      // If user re-records, don't reset useCount; bump it.
      useCount: existing.useCount + 1,
      // If a contradicted entry is re-recorded, bring it back to active —
      // the user explicitly affirmed it.
      status: existing.status === "contradicted" && input.kind === "user_correction" ? "active" : existing.status,
      // Merge sourceRef shallowly — keep the latest known refs.
      sourceRef: { ...existing.sourceRef, ...(input.sourceRef ?? {}) },
      tags: input.tags ?? existing.tags,
    }
    nextEntries = entries.map((e) => (e.id === id ? updated : e))
  } else {
    updated = makeEntry(input, nowMs)
    nextEntries = [...entries, updated]
  }

  await saveMemoryEntries(cwd, nextEntries)
  return updated
}

/** Remove an entry by id; returns true if it existed. */
export async function deleteEntry(cwd: string, id: string): Promise<boolean> {
  const entries = await loadMemoryEntries(cwd)
  const next = entries.filter((e) => e.id !== id)
  if (next.length === entries.length) return false
  await saveMemoryEntries(cwd, next)
  return true
}

/** Test-only: drop the cache. */
export function _resetCache(): void {
  cache.clear()
}

/** Test-only: write a memory file into a tmpdir and return its cwd. */
export async function _setupTempCwd(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sysflow-mem-"))
  return dir
}
