/**
 * Divergence detector — heuristic signals (Stage 1, no LLM).
 *
 * Pure function. Takes a snapshot of the run's state and returns the
 * signals that fired. The confidence-tracker consumes these signals and
 * scores the run; the LLM half (Stage 3) confirms the heuristics with a
 * Flash second-opinion before any user-visible action triggers.
 *
 * Each signal is tied to a category so the tracker can apply a weight.
 * Weights are tuned in confidence-tracker.ts, not here.
 */

import type { ChunkBoundary } from "./chunk-state.js"

export type DivergenceCategory =
  | "same_file_edited_repeatedly"
  | "repeated_tool_error"
  | "mkdir_empty_at_chunk_boundary"
  | "intent_keyword_absent"
  | "scope_creep"
  | "completion_claims_unwritten_files"

export interface DivergenceSignal {
  category: DivergenceCategory
  /** Short human-readable description. Surfaces in the CLI's "things to fix" list. */
  detail: string
  /** Optional severity hint for tuning weights downstream. */
  severity?: "minor" | "moderate" | "major"
}

export interface DetectorInput {
  /** Verbatim user prompt — the source of intent keywords. */
  originalPrompt: string
  /** Phase 10 chunk history for the run, oldest first. */
  chunkHistory: ChunkBoundary[]
  /** Files written or edited so far in the run (deduped path list). */
  filesModified: string[]
  /** Tool-error category counts seen so far in the run. */
  toolErrorCounts: Map<string, number>
  /** Mkdir paths created earlier in the run; used to spot empty-dir leftovers. */
  createdDirs: string[]
  /**
   * Just-emitted completion content (only set when normalized.kind === "completed").
   * Used to flag "claims-but-disk-empty" when the message names files that aren't
   * in filesModified.
   */
  completionMessage?: string | null
  /**
   * Optional planned chunk count from the preflight implementBrief.buildPlan;
   * used for scope-creep detection. Null when no plan was produced.
   */
  plannedChunkCount?: number | null
}

// ─── Tuning constants ───
const SAME_FILE_EDIT_THRESHOLD = 3      // > N edits to the same path
const TOOL_ERROR_REPEAT_THRESHOLD = 2   // > N occurrences of the same error category
const SCOPE_CREEP_RATIO = 1.5           // chunkCount > plannedChunkCount * RATIO

/** Common framework / DB / language keywords worth anchoring on. */
const INTENT_VOCAB = new Set([
  "postgres", "postgresql", "mysql", "sqlite", "mongodb", "mongo", "redis", "drizzle", "prisma", "knex", "sequelize",
  "react", "vue", "svelte", "solid", "preact", "angular", "next", "nuxt", "remix", "astro", "qwik", "sveltekit",
  "express", "fastify", "nest", "nestjs", "koa", "hapi",
  "django", "flask", "fastapi", "rails", "laravel", "spring",
  "tailwind", "bootstrap", "mui", "chakra",
  "tauri", "electron", "expo", "react-native",
  "typescript", "javascript", "python", "go", "rust", "java",
  "websocket", "graphql", "rest", "trpc", "grpc",
  "stripe", "auth0", "supabase", "firebase",
])

/**
 * Pure detector — no I/O, no LLM. Returns the signals that fired given
 * the input snapshot. Empty array means "looks fine on the heuristics".
 */
export function detectDivergence(input: DetectorInput): DivergenceSignal[] {
  const signals: DivergenceSignal[] = []

  // ─── Heuristic 1: same file edited too many times ───
  const fileEditCounts = countOccurrences(input.filesModified)
  for (const [path, count] of fileEditCounts) {
    if (count > SAME_FILE_EDIT_THRESHOLD) {
      signals.push({
        category: "same_file_edited_repeatedly",
        detail: `${path} has been edited ${count} times — possible stuck-loop or churn`,
        severity: "moderate",
      })
    }
  }

  // ─── Heuristic 2: repeated tool error class ───
  for (const [category, count] of input.toolErrorCounts) {
    if (count > TOOL_ERROR_REPEAT_THRESHOLD) {
      signals.push({
        category: "repeated_tool_error",
        detail: `tool error "${category}" repeated ${count} times — agent isn't recovering`,
        severity: "moderate",
      })
    }
  }

  // ─── Heuristic 3: directory created but empty at a chunk boundary ───
  for (const dir of input.createdDirs) {
    const hasContent = input.filesModified.some((f) => f.startsWith(dir.endsWith("/") ? dir : dir + "/"))
    if (!hasContent) {
      signals.push({
        category: "mkdir_empty_at_chunk_boundary",
        detail: `${dir} was created but no files have been written into it`,
        severity: "minor",
      })
    }
  }

  // ─── Heuristic 4: intent keyword from the user's prompt is absent ───
  const intentKeywords = extractIntentKeywords(input.originalPrompt)
  if (intentKeywords.length > 0 && input.filesModified.length > 0) {
    const haystack = (input.filesModified.join(" ") + " " + (input.completionMessage ?? "")).toLowerCase()
    const missing = intentKeywords.filter((kw) => !haystackContainsKeyword(haystack, kw))
    if (missing.length > 0) {
      signals.push({
        category: "intent_keyword_absent",
        detail: `user asked for ${missing.join(", ")} but no related files / mentions found`,
        severity: "major",
      })
    }
  }

  // ─── Heuristic 5: scope creep (chunkCount overshoots the plan) ───
  if (typeof input.plannedChunkCount === "number" && input.plannedChunkCount > 0) {
    const actualChunks = input.chunkHistory.length
    if (actualChunks > Math.max(1, Math.ceil(input.plannedChunkCount * SCOPE_CREEP_RATIO))) {
      signals.push({
        category: "scope_creep",
        detail: `${actualChunks} chunks executed vs ~${input.plannedChunkCount} planned — agent may be wandering`,
        severity: "minor",
      })
    }
  }

  // ─── Heuristic 6: completion claims files but in-memory log is empty ───
  if (input.completionMessage) {
    const claimedFiles = extractFilePathsFromMessage(input.completionMessage)
    const claimedButMissing = claimedFiles.filter((p) => !input.filesModified.some((f) => f.endsWith(p) || p.endsWith(f)))
    if (claimedFiles.length > 0 && claimedButMissing.length > 0) {
      signals.push({
        category: "completion_claims_unwritten_files",
        detail: `completion mentions ${claimedButMissing.slice(0, 3).join(", ")} but those files weren't written this run`,
        severity: "major",
      })
    }
  }

  return signals
}

// ─── Helpers ───

function countOccurrences(items: string[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const item of items) {
    counts.set(item, (counts.get(item) ?? 0) + 1)
  }
  return counts
}

/**
 * Pull tech keywords from the user's prompt. Filters against the INTENT_VOCAB
 * whitelist so generic words ("the", "build", etc.) don't trigger false
 * positives. Returns lowercased tokens.
 *
 * Tokens are matched whole first (catches multi-word entries like
 * "react-native") and then split on `-` so common modifier phrasings like
 * "postgres-backed" or "tailwind-style" still surface their root keyword.
 */
export function extractIntentKeywords(prompt: string): string[] {
  if (!prompt) return []
  const tokens = prompt.toLowerCase().match(/[a-z][a-z0-9-]+/g) ?? []
  const found = new Set<string>()
  for (const raw of tokens) {
    if (INTENT_VOCAB.has(raw)) {
      found.add(raw)
      continue
    }
    if (raw.includes("-")) {
      for (const part of raw.split("-")) {
        if (INTENT_VOCAB.has(part)) found.add(part)
      }
    }
  }
  return [...found]
}

function haystackContainsKeyword(haystack: string, kw: string): boolean {
  // Match either the literal keyword or common companion package names.
  if (haystack.includes(kw)) return true
  // Drizzle ORM uses 'drizzle-orm', Prisma uses '@prisma/client', etc. —
  // a substring match catches those too.
  return false
}

/**
 * Yank file-path-shaped tokens from a free-text completion message.
 * Conservative — only counts paths with an extension, to avoid matching
 * sentences with slashes.
 */
export function extractFilePathsFromMessage(message: string): string[] {
  if (!message) return []
  const matches = message.match(/[\w./-]+\.[a-z]{1,5}\b/gi) ?? []
  // Filter junk like "1.5x" or "v1.0" by requiring at least one slash OR a
  // multi-letter extension.
  return matches.filter((m) => m.includes("/") || m.includes("."))
    .filter((m) => !/^\d+\.\d+/.test(m))
    .map((m) => m.toLowerCase())
}
