/**
 * Markdown-with-frontmatter serialisation for the memory file.
 *
 * Why not JSON? — the user is expected to be able to open
 * .sysflow-memory.md, eyeball entries, and hand-edit/delete without
 * breaking a binary parser. Markdown is the only format that satisfies
 * "human auditable + machine parseable" without tooling.
 *
 * Each entry serialises as:
 *
 *   ## abc123def456 · decision
 *   <!--frontmatter
 *   createdAt: 1714500000000
 *   lastConfirmedAt: 1714500000000
 *   lastUsedAt: 1714500000000
 *   status: active
 *   useCount: 0
 *   contradictionCount: 0
 *   sourceRef:
 *     runId: r-abc
 *     trigger: self_invoked
 *     filePaths:
 *       - src/db/schema.ts
 *     packageDeps:
 *       - drizzle-orm
 *   tags:
 *     - orm
 *   frontmatter-->
 *
 *   <body — the entry content, free markdown text>
 *
 * Tolerant parser: malformed entries are skipped + logged; the valid
 * ones still load.
 */

import { memoryEntrySchema, type MemoryEntry } from "./entry-schema.js"

const FILE_HEADER = `<!-- AUTO-MANAGED by Sysflow. Edit/delete entries by hand if needed.
This file complements your hand-written .sysflow.md — both are read on every prompt.
Entries are validated at READ time; refs to deleted files/deps mark entries stale automatically. -->

# Sysflow Auto-Memory

`

const ENTRY_OPEN = "<!--frontmatter"
const ENTRY_CLOSE = "frontmatter-->"

export function serialiseEntries(entries: MemoryEntry[]): string {
  const blocks = entries.map(serialiseOne)
  return FILE_HEADER + blocks.join("\n\n---\n\n").trim() + "\n"
}

export function parseEntries(text: string): { entries: MemoryEntry[]; skipped: number } {
  const entries: MemoryEntry[] = []
  let skipped = 0
  if (!text || !text.trim()) return { entries, skipped }

  // Split on each `## <id> · <kind>` header. We use a regex with lookahead
  // to keep the headers attached to their bodies.
  const blocks = text.split(/(?=^##\s+[a-f0-9]{6,16}\s+·\s+)/m)
  for (const block of blocks) {
    const trimmed = block.trim()
    if (!trimmed.startsWith("## ")) continue
    try {
      const entry = parseOne(trimmed)
      if (entry) entries.push(entry)
      else skipped += 1
    } catch (err) {
      skipped += 1
      console.warn(`[memory-store] skipped malformed entry: ${(err as Error).message}`)
    }
  }
  return { entries, skipped }
}

function serialiseOne(e: MemoryEntry): string {
  const frontmatter = formatFrontmatter(e)
  return `## ${e.id} · ${e.kind}\n${ENTRY_OPEN}\n${frontmatter}${ENTRY_CLOSE}\n\n${e.content}`
}

function formatFrontmatter(e: MemoryEntry): string {
  const lines: string[] = []
  lines.push(`createdAt: ${e.createdAt}`)
  lines.push(`lastConfirmedAt: ${e.lastConfirmedAt}`)
  lines.push(`lastUsedAt: ${e.lastUsedAt}`)
  lines.push(`status: ${e.status}`)
  lines.push(`useCount: ${e.useCount}`)
  lines.push(`contradictionCount: ${e.contradictionCount}`)
  const sr = e.sourceRef ?? {}
  if (sr.runId || sr.trigger || (sr.filePaths && sr.filePaths.length > 0) || (sr.packageDeps && sr.packageDeps.length > 0)) {
    lines.push("sourceRef:")
    if (sr.runId) lines.push(`  runId: ${sr.runId}`)
    if (sr.trigger) lines.push(`  trigger: ${sr.trigger}`)
    if (sr.filePaths && sr.filePaths.length > 0) {
      lines.push("  filePaths:")
      for (const p of sr.filePaths) lines.push(`    - ${p}`)
    }
    if (sr.packageDeps && sr.packageDeps.length > 0) {
      lines.push("  packageDeps:")
      for (const d of sr.packageDeps) lines.push(`    - ${d}`)
    }
  }
  if (e.tags && e.tags.length > 0) {
    lines.push("tags:")
    for (const t of e.tags) lines.push(`  - ${t}`)
  }
  return lines.join("\n") + "\n"
}

function parseOne(block: string): MemoryEntry | null {
  // Header: "## <id> · <kind>"
  const headerMatch = block.match(/^##\s+([a-f0-9]{6,16})\s+·\s+(\w+)/)
  if (!headerMatch) return null
  const id = headerMatch[1]
  const kind = headerMatch[2]

  // Frontmatter block.
  const fmStart = block.indexOf(ENTRY_OPEN)
  const fmEnd = block.indexOf(ENTRY_CLOSE)
  if (fmStart < 0 || fmEnd < 0 || fmEnd <= fmStart) return null
  const fmBody = block.slice(fmStart + ENTRY_OPEN.length, fmEnd).trim()

  // Body comes after the frontmatter close.
  const bodyStart = fmEnd + ENTRY_CLOSE.length
  const content = block.slice(bodyStart).trim()
  if (!content) return null

  const fields = parseFrontmatter(fmBody)
  const candidate = {
    id,
    kind,
    content,
    createdAt: Number(fields.createdAt) || 0,
    lastConfirmedAt: Number(fields.lastConfirmedAt) || 0,
    lastUsedAt: Number(fields.lastUsedAt) || 0,
    sourceRef: fields.sourceRef ?? {},
    status: fields.status ?? "active",
    useCount: Number(fields.useCount) || 0,
    contradictionCount: Number(fields.contradictionCount) || 0,
    tags: fields.tags,
  }

  const parsed = memoryEntrySchema.safeParse(candidate)
  if (!parsed.success) return null
  return parsed.data
}

interface FrontmatterFields {
  createdAt?: string
  lastConfirmedAt?: string
  lastUsedAt?: string
  status?: string
  useCount?: string
  contradictionCount?: string
  sourceRef?: Record<string, unknown>
  tags?: string[]
}

function parseFrontmatter(text: string): FrontmatterFields {
  const out: FrontmatterFields = {}
  const lines = text.split("\n")
  let currentList: string[] | null = null
  let currentNested: Record<string, unknown> | null = null
  let nestedKey: string | null = null

  for (const raw of lines) {
    const line = raw.replace(/\r$/, "")
    if (!line.trim()) continue

    // Top-level "key:" or "key: value"
    const topMatch = line.match(/^(\w+):(?:\s*(.*))?$/)
    if (topMatch && !line.startsWith(" ")) {
      const key = topMatch[1]
      const value = (topMatch[2] ?? "").trim()
      currentList = null
      currentNested = null
      nestedKey = null
      if (value) {
        ;(out as Record<string, unknown>)[key] = value
      } else if (key === "sourceRef") {
        currentNested = {}
        out.sourceRef = currentNested
      } else if (key === "tags") {
        currentList = []
        out.tags = currentList
      }
      continue
    }

    // Nested under sourceRef.
    if (currentNested) {
      const nestedMatch = line.match(/^\s{2}(\w+):(?:\s*(.*))?$/)
      if (nestedMatch && !line.startsWith("    ")) {
        const k = nestedMatch[1]
        const v = (nestedMatch[2] ?? "").trim()
        if (v) {
          currentNested[k] = v
          nestedKey = null
        } else {
          // It's a list under a nested key.
          const list: string[] = []
          currentNested[k] = list
          nestedKey = k
        }
        continue
      }
      // Nested list item.
      const listItem = line.match(/^\s{4,}-\s*(.+)$/)
      if (listItem && nestedKey && Array.isArray(currentNested[nestedKey])) {
        ;(currentNested[nestedKey] as string[]).push(listItem[1].trim())
        continue
      }
    }

    // Top-level list item under tags.
    if (currentList) {
      const listItem = line.match(/^\s{2,}-\s*(.+)$/)
      if (listItem) {
        currentList.push(listItem[1].trim())
        continue
      }
    }
  }
  return out
}
