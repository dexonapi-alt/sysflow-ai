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
