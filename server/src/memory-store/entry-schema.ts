/**
 * Persistent reasoning memory — entry schema.
 *
 * Each entry captures a single fact about the project: a decision the agent
 * made, a summary of completed work, a user correction, or an explicit
 * preference the user typed via /remember.
 *
 * id is sha256(kind + content)[:12] so re-recording the same fact dedupes
 * naturally (the upserter overwrites the timestamps + counters in place).
 */

import crypto from "node:crypto"
import { z } from "zod"

export const entryKindSchema = z.enum([
  "decision",
  "implement",
  "bug_pattern",
  "user_correction",
  "preference",
  // Phase 10: per-chunk reflection summary written by the chunked-reasoning
  // loop. Lets `/continue` resume mid-stream — the next run reads back what
  // was decided in each chunk without re-running the planner.
  "chunk_summary",
])
export type EntryKind = z.infer<typeof entryKindSchema>

export const entryStatusSchema = z.enum(["active", "stale", "contradicted"])
export type EntryStatus = z.infer<typeof entryStatusSchema>

const sourceRefSchema = z.object({
  runId: z.string().max(64).optional(),
  trigger: z.string().max(40).optional(),
  filePaths: z.array(z.string().max(300)).max(10).optional(),
  packageDeps: z.array(z.string().max(80)).max(10).optional(),
})

export const memoryEntrySchema = z.object({
  id: z.string().min(1).max(20),
  kind: entryKindSchema,
  content: z.string().min(1).max(1500),
  createdAt: z.number().int().nonnegative(),
  lastConfirmedAt: z.number().int().nonnegative(),
  lastUsedAt: z.number().int().nonnegative(),
  sourceRef: sourceRefSchema.default({}),
  status: entryStatusSchema.default("active"),
  useCount: z.number().int().nonnegative().default(0),
  contradictionCount: z.number().int().nonnegative().default(0),
  tags: z.array(z.string().max(40)).max(8).optional(),
})
export type MemoryEntry = z.infer<typeof memoryEntrySchema>

export interface NewEntryInput {
  kind: EntryKind
  content: string
  sourceRef?: MemoryEntry["sourceRef"]
  tags?: string[]
}

/**
 * Deterministic entry id derived from (kind + content). Same content
 * recorded twice produces the same id, which the upserter uses to
 * dedupe + refresh timestamps in place rather than writing duplicates.
 */
export function entryId(kind: EntryKind, content: string): string {
  return crypto.createHash("sha256")
    .update(`${kind}::${content.trim()}`)
    .digest("hex")
    .slice(0, 12)
}

export function makeEntry(input: NewEntryInput, nowMs: number = Date.now()): MemoryEntry {
  const id = entryId(input.kind, input.content)
  return {
    id,
    kind: input.kind,
    content: input.content.trim(),
    createdAt: nowMs,
    lastConfirmedAt: nowMs,
    lastUsedAt: nowMs,
    sourceRef: input.sourceRef ?? {},
    status: "active",
    useCount: 0,
    contradictionCount: 0,
    tags: input.tags,
  }
}
