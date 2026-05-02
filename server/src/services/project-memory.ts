/**
 * Discover .sysflow.md (or CLAUDE.md fallback) files in the project tree
 * and inject their content into the system prompt.
 *
 * Discovery order, first match per slot:
 *   1. <cwd>/.sysflow.md  → falls back to <cwd>/CLAUDE.md
 *   2. <parent of cwd>/.sysflow.md  → fallback to CLAUDE.md
 *   3. ~/.sysflow/MEMORY.md (global per-user)
 *
 * Memoised per cwd with mtime-based invalidation. Hard cap at 50 000
 * chars combined; warning logged when the cap kicks in.
 *
 * Skips files that look like they contain secrets (.env, *.pem, id_rsa*).
 */

import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const MEMORY_FILE_PRIMARY = process.env.SYSFLOW_PROJECT_MEMORY_FILE || ".sysflow.md"
const MEMORY_FILE_FALLBACK = "CLAUDE.md"
const GLOBAL_MEMORY_PATH = path.join(os.homedir(), ".sysflow", "MEMORY.md")
const MAX_COMBINED_CHARS = 50_000
const SECRET_PATTERNS = [/\.env(\.|$)/i, /\.pem$/i, /id_rsa/i, /^secrets?\./i]

interface CacheEntry {
  mtimeMs: number
  combined: string
  files: string[]
}

const cache = new Map<string, CacheEntry>()

export interface ProjectMemoryResult {
  /** Combined markdown content; empty string when nothing found. */
  content: string
  /** Absolute paths of the files that contributed. */
  files: string[]
  /** Set if discovery hit the size cap and trimmed content. */
  truncated: boolean
}

export async function discoverProjectMemory(cwd: string | undefined | null): Promise<ProjectMemoryResult> {
  if (!cwd) return { content: "", files: [], truncated: false }

  const slots = [
    cwd,
    path.dirname(cwd),
    path.dirname(GLOBAL_MEMORY_PATH), // ~/.sysflow/
  ]

  // Cheap cache: hash slot mtimes; if any slot's primary or fallback file mtime
  // changed since the last call, invalidate.
  const cacheKey = slots.join("|")
  const stamp = await stampSlots(slots)
  const hit = cache.get(cacheKey)
  if (hit && hit.mtimeMs === stamp) {
    return { content: hit.combined, files: hit.files, truncated: hit.combined.length >= MAX_COMBINED_CHARS }
  }

  const collected: Array<{ file: string; body: string }> = []
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i]
    const isGlobal = i === 2
    const primary = isGlobal ? GLOBAL_MEMORY_PATH : path.join(slot, MEMORY_FILE_PRIMARY)
    const fallback = isGlobal ? null : path.join(slot, MEMORY_FILE_FALLBACK)

    const found = await firstReadable(primary, fallback)
    if (!found) continue
    if (looksLikeSecret(found.file)) continue
    collected.push(found)
  }

  let combined = collected
    .map((f) => `### ${path.basename(f.file)} (${f.file})\n\n${f.body.trim()}`)
    .join("\n\n---\n\n")

  let truncated = false
  if (combined.length > MAX_COMBINED_CHARS) {
    truncated = true
    combined = combined.slice(0, MAX_COMBINED_CHARS) + "\n\n[...project memory truncated by 50k cap...]"
    console.warn(`[project-memory] Truncated combined memory at ${MAX_COMBINED_CHARS} chars`)
  }

  const result: CacheEntry = { mtimeMs: stamp, combined, files: collected.map((f) => f.file) }
  cache.set(cacheKey, result)

  return { content: combined, files: result.files, truncated }
}

async function firstReadable(primary: string, fallback: string | null): Promise<{ file: string; body: string } | null> {
  try {
    const body = await fs.readFile(primary, "utf8")
    return { file: primary, body }
  } catch { /* primary missing — try fallback */ }
  if (fallback) {
    try {
      const body = await fs.readFile(fallback, "utf8")
      return { file: fallback, body }
    } catch { /* missing too */ }
  }
  return null
}

async function stampSlots(slots: string[]): Promise<number> {
  let stamp = 0
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i]
    const isGlobal = i === 2
    for (const fname of isGlobal ? [path.basename(GLOBAL_MEMORY_PATH)] : [MEMORY_FILE_PRIMARY, MEMORY_FILE_FALLBACK]) {
      const p = isGlobal ? GLOBAL_MEMORY_PATH : path.join(slot, fname)
      try {
        const stat = await fs.stat(p)
        stamp = Math.max(stamp, stat.mtimeMs)
      } catch { /* missing — contributes 0 */ }
    }
  }
  return stamp
}

function looksLikeSecret(p: string): boolean {
  const base = path.basename(p)
  return SECRET_PATTERNS.some((re) => re.test(base))
}
