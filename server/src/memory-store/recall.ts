/**
 * Recall — pick the most-relevant active memory entries to inject into the
 * reasoner's prompt.
 *
 * Relevance score = recency × useCount × token-overlap with userMessage.
 * Caps at MAX_RECALL_ENTRIES so the prompt section stays bounded.
 *
 * Pure: doesn't mutate, doesn't bump counters. Callers can wrap with
 * noteAccessed() if they want the lastUsedAt timestamps to move.
 */

import { loadMemoryEntries } from "./store.js"
import { runAllValidators, type ValidatedEntry } from "./validators.js"
import type { EntryKind } from "./entry-schema.js"

const MAX_RECALL_ENTRIES = 12
const RECENCY_WEIGHT = 1
const USE_COUNT_WEIGHT = 3
const OVERLAP_WEIGHT = 5
const USER_CORRECTION_BONUS = 50

export interface RecallArgs {
  cwd: string
  userMessage: string
  kind?: EntryKind
  maxEntries?: number
}

export interface RecallResult {
  entries: ValidatedEntry[]
  totalConsidered: number
  staleCount: number
  contradictedCount: number
}

export async function recallForReasoning(args: RecallArgs): Promise<RecallResult> {
  if (!args.cwd) {
    return { entries: [], totalConsidered: 0, staleCount: 0, contradictedCount: 0 }
  }
  const all = await loadMemoryEntries(args.cwd)
  const partition = runAllValidators(all, { cwd: args.cwd })

  let pool = partition.active
  if (args.kind) pool = pool.filter((e) => e.kind === args.kind)

  const tokens = tokenise(args.userMessage)
  const scored = pool.map((e) => ({
    entry: e,
    score: scoreEntry(e, tokens),
  }))
  scored.sort((a, b) => b.score - a.score)

  const cap = args.maxEntries ?? MAX_RECALL_ENTRIES
  const top = scored.slice(0, cap).map((s) => s.entry)

  return {
    entries: top,
    totalConsidered: all.length,
    staleCount: partition.stale.length,
    contradictedCount: partition.contradicted.length,
  }
}

function scoreEntry(e: ValidatedEntry, msgTokens: Set<string>): number {
  const recencyDays = Math.floor(e.lastUsedAt / 86_400_000)
  const overlap = countOverlap(tokenise(e.content), msgTokens)
  const bonus = e.kind === "user_correction" ? USER_CORRECTION_BONUS : 0
  return (
    recencyDays * RECENCY_WEIGHT +
    e.useCount * USE_COUNT_WEIGHT +
    overlap * OVERLAP_WEIGHT +
    bonus
  )
}

function tokenise(s: string): Set<string> {
  return new Set(
    (s || "")
      .toLowerCase()
      .replace(/[^a-z0-9_/.\s-]+/g, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 3),
  )
}

function countOverlap(a: Set<string>, b: Set<string>): number {
  let n = 0
  for (const t of a) if (b.has(t)) n += 1
  return n
}

export const _CONFIG = { MAX_RECALL_ENTRIES, USER_CORRECTION_BONUS }
