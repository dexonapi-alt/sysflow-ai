/**
 * Memory recorder — three best-effort writer functions called from the
 * reasoning pipeline + handler integration points.
 *
 * Recording is fire-and-forget: failures log but never throw into the
 * agent flow. The recorder also runs the same secret-pattern check as
 * project-memory so we never persist a credential by accident.
 */

import { upsertEntry } from "./store.js"
import { compactIfNeeded } from "./compaction.js"
import type { MemoryEntry, EntryKind } from "./entry-schema.js"

const SECRET_PATTERNS = [
  /\b(?:sk|pk)_(?:test|live)_[a-zA-Z0-9]{16,}/,                    // Stripe-style
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}/,                                    // AWS access key
  /\bAIza[0-9A-Za-z_-]{30,}/,                                       // Google API key
  /\bxox[abprs]-[a-zA-Z0-9-]{20,}/,                                 // Slack token
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,                                   // GitHub token
  /\bAPI_?KEY\s*[:=]\s*['"]?[A-Za-z0-9_\-]{20,}/i,                  // generic API_KEY
  /-----BEGIN [A-Z ]+PRIVATE KEY-----/,                             // PEM
]

interface DecisionLike {
  recommendation?: string
  alternatives?: Array<{ option?: string }>
  confidence?: string
  proceedHint?: string
}

interface ImplementLike {
  intent?: string
  recommendedStack?: { language?: string; frameworks?: string[]; libraries?: string[]; rationale?: string }
  consistencyNotes?: string[]
}

interface SourceRefLike {
  runId?: string
  trigger?: string
  filePaths?: string[]
  packageDeps?: string[]
}

function looksLikeSecret(text: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(text))
}

async function safeRecord(cwd: string, kind: EntryKind, content: string, sourceRef?: SourceRefLike, tags?: string[]): Promise<MemoryEntry | null> {
  if (!cwd) return null
  if (!content || !content.trim()) return null
  if (looksLikeSecret(content)) {
    console.warn(`[memory-store] refused to persist entry — content looks like a secret`)
    return null
  }
  try {
    const entry = await upsertEntry(cwd, { kind, content: content.trim(), sourceRef, tags })
    // Best-effort compaction after every write.
    compactIfNeeded(cwd).catch(() => { /* never block */ })
    return entry
  } catch (err) {
    console.warn(`[memory-store] record failed (${kind}):`, (err as Error).message)
    return null
  }
}

export async function recordDecision(
  cwd: string,
  brief: { decisionBrief?: DecisionLike; confidence?: string },
  sourceRef: SourceRefLike,
): Promise<MemoryEntry | null> {
  // Don't memorialise low-confidence decisions — the agent should
  // re-deliberate next time rather than ossify a guess.
  if (brief.confidence === "LOW") return null
  const db = brief.decisionBrief
  if (!db || !db.recommendation) return null

  const content = [
    `Decision: ${db.recommendation}`,
    db.confidence ? `Confidence: ${db.confidence}` : null,
    db.proceedHint ? `Proceed: ${db.proceedHint}` : null,
  ].filter(Boolean).join("\n")

  return safeRecord(cwd, "decision", content, sourceRef, ["reason-tool"])
}

export async function recordImplementSummary(
  cwd: string,
  brief: { implementBrief?: ImplementLike },
  sourceRef: SourceRefLike,
): Promise<MemoryEntry | null> {
  const ib = brief.implementBrief
  if (!ib || !ib.recommendedStack) return null
  const stack = ib.recommendedStack
  const stackParts = [
    stack.language,
    ...(stack.frameworks ?? []),
    ...(stack.libraries ?? []),
  ].filter(Boolean).join(" + ")
  if (!stackParts) return null

  const noteLines = (ib.consistencyNotes ?? []).slice(0, 3).map((n) => `- ${n}`)
  const content = [
    `Implement: ${ib.intent ?? "(no intent recorded)"}`,
    `Stack: ${stackParts}`,
    stack.rationale ? `Rationale: ${stack.rationale}` : null,
    noteLines.length > 0 ? `Notes:\n${noteLines.join("\n")}` : null,
  ].filter(Boolean).join("\n")

  // Stack libraries become packageDeps so the dep-ref validator can
  // mark this entry stale if the user removes them later.
  const packageDeps = (stack.libraries ?? []).filter((l) => /^[a-z0-9@\-/.]+$/i.test(l))
  const enrichedRef: SourceRefLike = { ...sourceRef, packageDeps: [...(sourceRef.packageDeps ?? []), ...packageDeps] }
  return safeRecord(cwd, "implement", content, enrichedRef, ["completion"])
}

export async function recordUserCorrection(
  cwd: string,
  text: string,
  sourceRef: SourceRefLike = { trigger: "/remember" },
): Promise<MemoryEntry | null> {
  // user_correction always records when the input is non-empty + not secret.
  return safeRecord(cwd, "user_correction", text, sourceRef, ["user-typed"])
}

export async function recordBugPattern(
  cwd: string,
  briefSummary: string,
  filePaths: string[] | undefined,
  sourceRef: SourceRefLike,
): Promise<MemoryEntry | null> {
  const enriched: SourceRefLike = { ...sourceRef, filePaths: filePaths ?? sourceRef.filePaths }
  return safeRecord(cwd, "bug_pattern", briefSummary, enriched, ["bug"])
}

/**
 * Phase 11: persist the user's verbatim prompt as `original_intent`.
 *
 * Called once per new run from `user-message.ts`. The Phase 11 divergence
 * detector and Stage 4's backtrack flow read this back so they can compare
 * the implementation against the LITERAL ask — preflight brief
 * interpretations get stale or outright wrong on free models. The anchor
 * wins.
 *
 * Trimmed to ~1490 chars (the schema cap is 1500); longer prompts are
 * truncated with a "…" marker since the goal is intent capture, not full
 * archival. The id is sha256(kind+content), so two identical prompts in
 * the same project dedupe naturally — re-recording on a follow-up message
 * is a no-op.
 */
export async function recordOriginalIntent(
  cwd: string,
  verbatimPrompt: string,
  sourceRef: SourceRefLike = { trigger: "user_message" },
): Promise<MemoryEntry | null> {
  if (!verbatimPrompt || !verbatimPrompt.trim()) return null
  const trimmed = verbatimPrompt.trim()
  const content = trimmed.length > 1490 ? trimmed.slice(0, 1490) + "…" : trimmed
  return safeRecord(cwd, "original_intent", content, sourceRef, ["user-typed", "anchor"])
}

interface ChunkSummaryLike {
  chunkIndex: number
  nextAction?: string
  executedFiles?: string[]
  reflection?: {
    coherent?: boolean
    nextFocus?: string
    issues?: string[]
    shouldStop?: boolean
  }
}

/**
 * Record one chunk's outcome from the chunked-reasoning loop (Phase 10).
 *
 * Persisted so a later `/continue` can recall *what was done in chunk N*
 * and *what the reflector said to focus on next* without re-running the
 * loop. Files touched become part of the sourceRef so the file-existence
 * validator marks the entry stale if those files are later removed.
 */
export async function recordChunkSummary(
  cwd: string,
  summary: ChunkSummaryLike,
  sourceRef: SourceRefLike,
): Promise<MemoryEntry | null> {
  const reflectionLines: string[] = []
  if (summary.reflection?.coherent === false) {
    reflectionLines.push(`Issues: ${(summary.reflection.issues ?? []).slice(0, 3).join("; ")}`)
  }
  if (summary.reflection?.nextFocus) {
    reflectionLines.push(`Next focus: ${summary.reflection.nextFocus}`)
  }
  if (summary.reflection?.shouldStop) {
    reflectionLines.push(`Reflector flagged: should stop after this chunk.`)
  }

  const content = [
    `Chunk ${summary.chunkIndex}${summary.nextAction ? `: ${summary.nextAction}` : ""}`,
    summary.executedFiles && summary.executedFiles.length > 0
      ? `Files: ${summary.executedFiles.slice(0, 8).join(", ")}`
      : null,
    ...reflectionLines,
  ].filter(Boolean).join("\n")

  if (!content.trim()) return null

  const enriched: SourceRefLike = {
    ...sourceRef,
    filePaths: [...(sourceRef.filePaths ?? []), ...(summary.executedFiles ?? [])].slice(0, 10),
  }
  return safeRecord(cwd, "chunk_summary", content, enriched, ["chunk"])
}
