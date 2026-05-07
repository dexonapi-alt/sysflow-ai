/**
 * Phase 15 Stage 3: model-driven memory feedback application.
 *
 * The model's response carries a structured `memoryFeedback` field listing
 * entry ids it confirmed (used during the turn) and ids it contradicted
 * (the conversation disagreed with). This helper validates those claims
 * against the actual response text — free-tier models hallucinate which
 * ids they "confirmed" and which they "contradicted", so we cross-check
 * before mutating the store.
 *
 * Cross-validation rules:
 *
 *   - **confirmed**: the entry's content must overlap with the response
 *     text by at least 30% of meaningful tokens (lower-cased, ≥ 4 chars,
 *     dash-split, stopwords removed). If a model claims to have used an
 *     entry whose content nowhere appears in its output, the claim is
 *     rejected. False positives are cheap (one bumped useCount); false
 *     confirms accumulate noise that future recall promotes.
 *
 *   - **contradicted**: the response must explicitly reference the entry
 *     id in bracket notation, e.g. `[abc123]` — the same notation the
 *     LEARNED_MEMORY prompt section uses to render entries. This is a
 *     stricter bar than overlap because killing an entry is irreversible
 *     after 2 strikes; we want the model to point at exactly which entry
 *     it's disagreeing with.
 *
 * Returns a per-id audit log so the caller can log telemetry. The actual
 * store mutations (`noteAgreement` / `noteContradiction`) are best-effort
 * and never throw into the agent flow.
 */

import { loadMemoryEntries } from "./store.js"
import { noteAgreement, noteContradiction } from "./confirmation-tracker.js"
import type { MemoryEntry } from "./entry-schema.js"

export interface MemoryFeedback {
  /** Entry ids the model claims it used / agrees with this turn. */
  confirmed?: string[]
  /** Entry ids the model claims the conversation disagreed with. */
  contradicted?: string[]
}

export interface ApplyMemoryFeedbackResult {
  /** Confirmed ids whose content appeared in the response — `noteAgreement` was called. */
  confirmedHonoured: string[]
  /** Confirmed ids that failed cross-validation (entry content didn't appear). */
  confirmedRejected: string[]
  /** Contradicted ids that were explicitly referenced in the response — `noteContradiction` was called. */
  contradictedHonoured: string[]
  /** Contradicted ids that weren't explicitly referenced (rejected). */
  contradictedRejected: string[]
}

/**
 * Stopwords excluded from token overlap. Kept tight — these are words
 * that appear in almost any sentence and would inflate overlap ratios
 * even when the actual semantic content doesn't match.
 */
const STOPWORDS = new Set([
  "the", "and", "for", "with", "use", "this", "that", "from", "into",
  "have", "been", "are", "not", "but", "all", "any", "you", "can",
  "will", "would", "should", "could", "more", "less", "than", "when",
  "where", "what", "which", "who", "how", "why", "make", "made",
  "your", "their", "ours", "mine", "they", "them", "him", "her",
])

/** Confirmation threshold — at least this fraction of meaningful entry
 *  tokens must appear in the response text for the confirm to be honoured. */
const CONFIRM_OVERLAP_THRESHOLD = 0.3

/**
 * Pure: does the response text overlap meaningfully with the entry content?
 * Returns true when the overlap of stopword-stripped tokens hits the
 * threshold. Exported so the contract is unit-testable without a store.
 */
export function validateConfirmation(entryContent: string, responseText: string): boolean {
  const entryTokens = tokenize(entryContent)
  if (entryTokens.size === 0) return false
  const responseTokens = tokenize(responseText)
  let overlap = 0
  for (const t of entryTokens) {
    if (responseTokens.has(t)) overlap++
  }
  return overlap / entryTokens.size >= CONFIRM_OVERLAP_THRESHOLD
}

/**
 * Pure: does the response text explicitly reference the entry id in
 * bracket notation? The LEARNED_MEMORY prompt section renders entries as
 * `[<id>] kind: content`, so referencing the id is the contract for any
 * statement specifically about that entry.
 */
export function validateContradiction(entryId: string, responseText: string): boolean {
  if (!entryId || !responseText) return false
  return responseText.includes(`[${entryId}]`)
}

function tokenize(text: string): Set<string> {
  if (typeof text !== "string") return new Set()
  // Split on anything that's not a-z / 0-9 / _ — dashes act as word
  // boundaries so "postgres-backed" → ["postgres", "backed"]. Length
  // floor of 4 keeps short helper words ("with", "this") out of the set.
  const tokens = text.toLowerCase().match(/[a-z0-9_]{4,}/g) ?? []
  return new Set(tokens.filter((t) => !STOPWORDS.has(t)))
}

/**
 * Apply the model's `memoryFeedback` to the on-disk store, with
 * cross-validation guards. Each guard rejects hallucinated claims so a
 * free-tier model can't silently bump useCount on entries it didn't use
 * or kill entries it never actually disagreed with.
 *
 * Best-effort: never throws into the caller. A failed store load returns
 * an empty audit log; a failed mutation logs at warn level via the
 * underlying tracker.
 */
export async function applyMemoryFeedback(
  cwd: string,
  feedback: MemoryFeedback | null | undefined,
  responseText: string,
): Promise<ApplyMemoryFeedbackResult> {
  const result: ApplyMemoryFeedbackResult = {
    confirmedHonoured: [],
    confirmedRejected: [],
    contradictedHonoured: [],
    contradictedRejected: [],
  }

  if (!cwd || !feedback || typeof responseText !== "string") return result

  const confirmed = Array.isArray(feedback.confirmed) ? feedback.confirmed.filter((s): s is string => typeof s === "string") : []
  const contradicted = Array.isArray(feedback.contradicted) ? feedback.contradicted.filter((s): s is string => typeof s === "string") : []
  if (confirmed.length === 0 && contradicted.length === 0) return result

  let entries: MemoryEntry[]
  try {
    entries = await loadMemoryEntries(cwd)
  } catch {
    return result
  }
  const byId = new Map(entries.map((e) => [e.id, e]))

  for (const id of confirmed) {
    const entry = byId.get(id)
    if (!entry) {
      // Unknown id — most likely the model referenced an entry that has
      // already been compacted away. Reject silently rather than poisoning
      // the audit log with phantom positives.
      result.confirmedRejected.push(id)
      continue
    }
    if (validateConfirmation(entry.content, responseText)) {
      await noteAgreement(cwd, id).catch(() => { /* tracker logs */ })
      result.confirmedHonoured.push(id)
    } else {
      result.confirmedRejected.push(id)
    }
  }

  for (const id of contradicted) {
    const entry = byId.get(id)
    if (!entry) {
      result.contradictedRejected.push(id)
      continue
    }
    if (validateContradiction(id, responseText)) {
      await noteContradiction(cwd, id).catch(() => { /* tracker logs */ })
      result.contradictedHonoured.push(id)
    } else {
      result.contradictedRejected.push(id)
    }
  }

  return result
}

export const _CONFIG = {
  CONFIRM_OVERLAP_THRESHOLD,
  STOPWORDS,
}
