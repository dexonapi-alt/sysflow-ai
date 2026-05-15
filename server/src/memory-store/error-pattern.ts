/**
 * Plan `2026-05-15-forced-error-reasoning-and-recovery.md` Stage 5.
 *
 * Error-pattern memory — records and recalls tool errors the agent has
 * recovered from. After an error → reasoner → retry → success sequence,
 * `recordErrorPattern` writes a structured entry: which tool, which
 * platform, the error signature, the failing command, and the command
 * that worked. The next time a similar error fires, `recallErrorPatterns`
 * surfaces the prior fix to the error-reasoning chain as `priorRecall`
 * (the field is already plumbed in `error-reasoner.ts`).
 *
 * Content format is parseable for round-trip (the schema only has
 * `content` + `sourceRef`, no structured metadata field, so structured
 * data is folded into content as labelled lines):
 *
 *   ```
 *   Error pattern: command_not_found on win32
 *   Failed: ls -R
 *   Worked: dir /s
 *   Signature: 'ls' is not recognized as an internal or external command
 *   ```
 *
 * Recall scores by signature token-overlap, requires platform match,
 * and returns top-N. Same recency × useCount × overlap shape as
 * `recallForReasoning` so the heuristics agree across kinds.
 */

import { loadMemoryEntries } from "./store.js"
import { runAllValidators, type ValidatedEntry } from "./validators.js"
import type { MemoryEntry } from "./entry-schema.js"

const SECRET_PATTERNS = [
  /\b(?:sk|pk)_(?:test|live)_[a-zA-Z0-9]{16,}/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
  /\bxox[abprs]-[a-zA-Z0-9-]{20,}/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bAPI_?KEY\s*[:=]\s*['"]?[A-Za-z0-9_\-]{20,}/i,
  /-----BEGIN [A-Z ]+PRIVATE KEY-----/,
]

function looksLikeSecret(text: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(text))
}

/** Cap on how much of the error message we persist as the signature.
 *  Too short → false matches across unrelated errors with similar
 *  preamble. Too long → token-overlap scoring drowns the actual signal. */
const SIGNATURE_MAX_LENGTH = 240

/** Truncate command/error fields so a runaway-long input can't blow
 *  the entry past the schema's 1500-char content cap. */
const COMMAND_MAX_LENGTH = 400

export interface ErrorPatternFields {
  errorClass: string
  platform: string
  failedCommand: string
  workingCommand: string
  errorSignature: string
}

export interface RecordErrorPatternArgs extends ErrorPatternFields {
  cwd: string
  runId?: string
}

/**
 * Format the structured error-pattern fields as the entry's content
 * string. Pure — exported for tests and so the recall round-trip uses
 * the same shape.
 */
export function formatErrorPatternContent(fields: ErrorPatternFields): string {
  return [
    `Error pattern: ${fields.errorClass} on ${fields.platform}`,
    `Failed: ${truncate(fields.failedCommand, COMMAND_MAX_LENGTH)}`,
    `Worked: ${truncate(fields.workingCommand, COMMAND_MAX_LENGTH)}`,
    `Signature: ${truncate(fields.errorSignature, SIGNATURE_MAX_LENGTH)}`,
  ].join("\n")
}

/**
 * Parse an entry's content back into structured fields. Returns null
 * if the content doesn't match the expected shape (e.g. the entry was
 * written by an older version or by hand). Pure.
 */
export function parseErrorPatternContent(content: string): ErrorPatternFields | null {
  const lines = content.split(/\r?\n/).map((l) => l.trim())
  const headerMatch = lines[0]?.match(/^Error pattern: (.+?) on (.+)$/)
  if (!headerMatch) return null
  const errorClass = headerMatch[1].trim()
  const platform = headerMatch[2].trim()

  const failedLine = lines.find((l) => l.startsWith("Failed: "))
  const workedLine = lines.find((l) => l.startsWith("Worked: "))
  const sigLine = lines.find((l) => l.startsWith("Signature: "))
  if (!failedLine || !workedLine || !sigLine) return null

  return {
    errorClass,
    platform,
    failedCommand: failedLine.slice("Failed: ".length).trim(),
    workingCommand: workedLine.slice("Worked: ".length).trim(),
    errorSignature: sigLine.slice("Signature: ".length).trim(),
  }
}

/**
 * Record an error_pattern entry. Best-effort: returns null on missing
 * required fields, secret-looking content, or storage failures so the
 * caller can fire-and-forget. Same secret-check + safeRecord pattern
 * as `recorder.ts`.
 *
 * Imports `upsertEntry` lazily to avoid pulling the whole store at
 * test-collect time when the cwd is a tmpdir.
 */
export async function recordErrorPattern(args: RecordErrorPatternArgs): Promise<MemoryEntry | null> {
  if (!args.cwd) return null
  if (!args.failedCommand || !args.workingCommand) return null
  if (!args.errorSignature) return null
  if (args.failedCommand.trim() === args.workingCommand.trim()) return null
  const content = formatErrorPatternContent(args)
  if (looksLikeSecret(content)) {
    console.warn(`[memory-store] refused to persist error_pattern — content looks like a secret`)
    return null
  }
  const { upsertEntry } = await import("./store.js")
  const { compactIfNeeded } = await import("./compaction.js")
  try {
    const entry = await upsertEntry(args.cwd, {
      kind: "error_pattern",
      content,
      sourceRef: { runId: args.runId, trigger: "on_error_recovery" },
      tags: ["error", "recovery", args.platform],
    })
    compactIfNeeded(args.cwd).catch(() => { /* never block */ })
    return entry
  } catch (err) {
    console.warn(`[memory-store] recordErrorPattern failed:`, (err as Error).message)
    return null
  }
}

export interface RecallErrorPatternsArgs {
  cwd: string
  errorSignature: string
  platform: string
  maxEntries?: number
}

export interface ErrorPatternMatch {
  entry: ValidatedEntry
  fields: ErrorPatternFields
  score: number
}

const DEFAULT_MAX_PATTERN_MATCHES = 3
const OVERLAP_WEIGHT = 5
const USE_COUNT_WEIGHT = 2
const RECENCY_WEIGHT = 1
const MIN_OVERLAP_TOKENS = 1

/**
 * Recall the top-N error_pattern entries whose platform matches the
 * given platform AND whose signature shares enough vocabulary with the
 * current error. Pure-ish (reads from disk but doesn't mutate). Caller
 * can `noteAccessed` if they want the lastUsedAt to bump.
 *
 * Empty array when no matches — callers should treat as "no prior
 * pattern available" and let the reasoner start fresh.
 */
export async function recallErrorPatterns(args: RecallErrorPatternsArgs): Promise<ErrorPatternMatch[]> {
  if (!args.cwd || !args.errorSignature || !args.platform) return []
  const all = await loadMemoryEntries(args.cwd)
  if (all.length === 0) return []
  const { active } = runAllValidators(all, { cwd: args.cwd })

  const sigTokens = tokenise(args.errorSignature)
  if (sigTokens.size === 0) return []

  const matches: ErrorPatternMatch[] = []
  for (const entry of active) {
    if (entry.kind !== "error_pattern") continue
    const fields = parseErrorPatternContent(entry.content)
    if (!fields) continue
    if (fields.platform !== args.platform) continue
    const entryTokens = tokenise(fields.errorSignature)
    const overlap = countOverlap(sigTokens, entryTokens)
    if (overlap < MIN_OVERLAP_TOKENS) continue
    const recencyDays = Math.floor(entry.lastUsedAt / 86_400_000)
    const score = (
      overlap * OVERLAP_WEIGHT +
      entry.useCount * USE_COUNT_WEIGHT +
      recencyDays * RECENCY_WEIGHT
    )
    matches.push({ entry, fields, score })
  }

  matches.sort((a, b) => b.score - a.score)
  return matches.slice(0, args.maxEntries ?? DEFAULT_MAX_PATTERN_MATCHES)
}

/**
 * Render matches as a human-readable block to pass through the
 * error reasoner's `priorRecall` user-turn slot. Returns null when
 * there are no matches so callers can skip the field entirely.
 */
export function formatRecallForReasoner(matches: ErrorPatternMatch[]): string | null {
  if (matches.length === 0) return null
  const lines: string[] = []
  lines.push(`Sysflow has recorded ${matches.length} prior recovered-from error pattern${matches.length === 1 ? "" : "s"} on this machine.`)
  lines.push(`Last time the agent hit a similar error, these commands worked:`)
  lines.push("")
  for (const m of matches) {
    lines.push(`- Failed: ${m.fields.failedCommand}`)
    lines.push(`  Worked: ${m.fields.workingCommand}`)
    lines.push(`  (${m.fields.errorClass}, ${m.fields.platform})`)
  }
  lines.push("")
  lines.push(`Confirm or revise — if the same fix still applies, lean toward it. If the context invalidates it (different file / different intent), say so and pick a different recommendation.`)
  return lines.join("\n")
}

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "have", "has", "had",
  "are", "was", "were", "will", "would", "could", "should", "been", "being",
  "but", "not", "yes", "any", "all", "you", "your", "our", "their", "its",
  "into", "onto", "upon", "than", "then", "what", "when", "where", "which",
  "who", "why", "how", "out", "off", "over", "under", "between",
])

function tokenise(s: string): Set<string> {
  return new Set(
    (s || "")
      .toLowerCase()
      .replace(/[^a-z0-9_\s./\-:]+/g, " ")
      .split(/\s+/)
      .map((t) => t.replace(/^[.\-/:]+|[.\-/:]+$/g, ""))
      .filter((t) => t.length >= 3 && !STOP_WORDS.has(t)),
  )
}

function countOverlap(a: Set<string>, b: Set<string>): number {
  let n = 0
  for (const t of a) if (b.has(t)) n += 1
  return n
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max - 1) + "…"
}

export const _CONFIG = {
  SIGNATURE_MAX_LENGTH,
  COMMAND_MAX_LENGTH,
  DEFAULT_MAX_PATTERN_MATCHES,
  MIN_OVERLAP_TOKENS,
}
