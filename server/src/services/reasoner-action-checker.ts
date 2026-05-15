/**
 * Stage 5 of free-tier quality enforcement: reasoner-vs-action cross-check.
 *
 * Detects the failure mode where the model's per-turn `reasoningChain`
 * states ONE intent ("I'm going to verify the import resolves by
 * grepping the source") and then the action it actually emits IS A
 * DIFFERENT category (a `write_file` instead of a `run_command grep`).
 *
 * Pure, no I/O, no LLM. Lives next to `divergence-detector.ts` since the
 * confidence-tracker consumes its output via a new
 * `reasoning_action_mismatch` divergence category.
 *
 * Design choice — CONSERVATIVE: only fires on UNAMBIGUOUS mismatches.
 *   - Read-intent + write-tool = mismatch  ← the clearest case
 *   - Write-intent + read-only-tool = no mismatch (legitimate setup;
 *     "I'm going to write X; first let me read Y" is common, and the
 *     reasoning often covers both intents)
 *   - Mixed intent (reasoning mentions BOTH read and write verbs) = no mismatch
 *   - Empty / short reasoning = no mismatch (no claim to contradict)
 *
 * Severity `moderate` (weight 10 in confidence-tracker — same as the
 * scope_creep tier — see Risks: false positives expected to be rare but
 * not zero, so a single fire decays by 7.5 points; takes 3+ fires to
 * trip the off-course threshold on its own).
 *
 * Plan reference: `.claude/plans/2026-05-15-free-tier-quality-enforcement.md`
 * Stage 5.
 */

/**
 * Tool category for the action being inspected. Keep this synced with
 * the tool list the executor knows about — adding a new tool here
 * doesn't break anything (it defaults to `other`), but mapping it
 * correctly lets the cross-checker see it.
 *
 * Note: `run_command` is split by content (safe-read vs. other). The
 * caller is expected to classify the command via `isSafeReadOnlyCommand`
 * before passing the action through, since the safe-commands module is
 * the source of truth for that classification.
 */
export type ToolCategory =
  | "read"   // read_file, list_directory, batch_read, search, glob, grep, run_command(safe)
  | "write"  // write_file, edit_file, batch_write
  | "mkdir"  // create_directory
  | "other"  // run_command(non-safe), _user_response, anything unmapped

/** Argument to the cross-checker. The shape mirrors the `runLog.actions`
 *  entries the tool-result handler already builds. */
export interface ActionDescriptor {
  tool: string
  /** Path arg if present. */
  path?: string | null
  /** Command arg if present (run_command only). */
  command?: string | null
  /** Pre-classified safety verdict for the command (computed via
   *  `isSafeReadOnlyCommand`). True only when the command is a read-only
   *  investigation; false / undefined for write/general commands. */
  commandIsSafeReadOnly?: boolean
}

export interface CrossCheckResult {
  /** True when the action plausibly fulfils the reasoning's stated
   *  intent. False when an UNAMBIGUOUS mismatch was detected. */
  matches: boolean
  /** When `matches === false`, a one-line description suitable for the
   *  divergence signal's `detail` field. Undefined on match. */
  reason?: string
}

// ─── Intent vocab (small, conservative) ───
//
// The detector reads the FINAL paragraph of the chain — that's the
// agent's stated next-step intent, which the upcoming action should
// fulfil. Earlier paragraphs cover the broader plan and would produce
// false-positive mixed-intent triggers if scanned alongside.
//
// Words are matched case-insensitively with rough word-boundary checks
// (regex `\bword\b`). Substring matches on bare letters would over-fire
// (e.g. "patch" → matches "dispatch"); regex word-boundary fixes that.

const READ_INTENT_WORDS = [
  "verify", "verifying",
  "check", "checking",
  "investigate", "investigating",
  "inspect", "inspecting",
  "examine", "examining",
  "look at", "look into", "looking at", "looking into",
  "read", "reading",
  "confirm", "confirming",
  "validate", "validating",
  "audit", "auditing",
  "search", "searching",
  "grep", "grepping",
  "find out", "finding out",
  "scan", "scanning",
  "list", "listing",
  "review", "reviewing",
]

const WRITE_INTENT_WORDS = [
  "write", "writing",
  "create", "creating",
  "scaffold", "scaffolding",
  "implement", "implementing",
  "generate", "generating",
  "edit", "editing",
  "modify", "modifying",
  "add", "adding",
  "build", "building",
  "make", "making",
  "fix", "fixing",
  "patch", "patching",
  "refactor", "refactoring",
  "delete", "deleting",
  "remove", "removing",
]

const READ_TOOLS = new Set([
  "read_file",
  "list_directory",
  "batch_read",
  "search_files",
  "search",
  "glob",
  "grep",
])

const WRITE_TOOLS = new Set([
  "write_file",
  "edit_file",
  "batch_write",
])

const MKDIR_TOOLS = new Set([
  "create_directory",
])

/**
 * Classify a tool call into the broad category the reasoner-action
 * checker compares against. Exported so tests can pin the mapping.
 */
export function classifyToolCategory(action: ActionDescriptor): ToolCategory {
  const tool = action.tool
  if (!tool || typeof tool !== "string") return "other"
  if (READ_TOOLS.has(tool)) return "read"
  if (WRITE_TOOLS.has(tool)) return "write"
  if (MKDIR_TOOLS.has(tool)) return "mkdir"
  if (tool === "run_command") {
    return action.commandIsSafeReadOnly === true ? "read" : "other"
  }
  return "other"
}

/** Pure scan: does the reasoning text contain any read-intent verb in a
 *  word-boundary position? */
function hasReadIntent(text: string): boolean {
  return READ_INTENT_WORDS.some((kw) => new RegExp(`\\b${escapeRegex(kw)}\\b`, "i").test(text))
}

/** Pure scan: does the reasoning text contain any write-intent verb? */
function hasWriteIntent(text: string): boolean {
  return WRITE_INTENT_WORDS.some((kw) => new RegExp(`\\b${escapeRegex(kw)}\\b`, "i").test(text))
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Minimum length of reasoning text to bother classifying. Below this
 * threshold the chain is too short to make a stable claim about intent,
 * so we skip cross-checking to avoid false positives on terse paragraphs
 * like "Continue." or "Ok.". The number matches the divergence-detector's
 * `MIN_SUBSTANTIVE_PROMPT_CHARS` convention for the same reason.
 */
const MIN_REASONING_CHARS = 30

/**
 * Cross-check the most recent reasoning paragraph against the action
 * the agent just emitted. Returns `{ matches: true }` when the pairing
 * is plausible (or when the reasoning is too short / mixed-intent to
 * judge); returns `{ matches: false, reason }` only on UNAMBIGUOUS
 * mismatches.
 *
 * The "last reasoning paragraph" is what we scan: the chain's later
 * paragraphs cover the immediate next-step intent, while earlier ones
 * cover broader plan-of-action. Caller passes the final paragraph (or
 * the whole chain joined — works either way; the intent words just
 * happen to land in the later paragraphs).
 */
export function crossCheckReasoningAction(lastReasoning: string | null | undefined, action: ActionDescriptor): CrossCheckResult {
  if (!lastReasoning || typeof lastReasoning !== "string") return { matches: true }
  const trimmed = lastReasoning.trim()
  if (trimmed.length < MIN_REASONING_CHARS) return { matches: true }

  const readIntent = hasReadIntent(trimmed)
  const writeIntent = hasWriteIntent(trimmed)

  // Mixed intent — agent's reasoning covers both. Whatever it does next
  // is plausibly justified. Skip the check.
  if (readIntent && writeIntent) return { matches: true }

  // Neither intent surfaced — reasoning is about something else (e.g.
  // discussing trade-offs, summarising progress). No comparable claim.
  if (!readIntent && !writeIntent) return { matches: true }

  const category = classifyToolCategory(action)

  // ── The ONE case we flag: explicit read intent, but a write action.
  if (readIntent && !writeIntent) {
    if (category === "write" || category === "mkdir") {
      const intent = describeReasoning(trimmed)
      const tool = action.tool
      const target = action.path ?? action.command ?? "(none)"
      return {
        matches: false,
        reason: `reasoningChain said "${intent}" but action was ${tool} on ${target}`,
      }
    }
  }

  // Write intent + read action is NOT flagged — legitimate "going to
  // write X; first let me read Y" pattern. Same for write intent + other.
  return { matches: true }
}

/** Shorten the reasoning text into the part that mentions the intent
 *  verb, so the divergence signal's `detail` field is short + readable. */
function describeReasoning(reasoning: string): string {
  // Match a verb plus the small clause around it (up to 30 chars before
  // and 30 after). When that fails (no match), fall back to the first
  // 60 chars of the reasoning.
  for (const kw of [...READ_INTENT_WORDS, ...WRITE_INTENT_WORDS]) {
    const m = reasoning.match(new RegExp(`(.{0,30}\\b${escapeRegex(kw)}\\b.{0,30})`, "i"))
    if (m) return m[1].trim()
  }
  return reasoning.slice(0, 60).trim()
}

/**
 * Pick the most relevant paragraph from a reasoning chain. Convention:
 * the LAST non-empty paragraph carries the imminent next-step intent.
 * Caller may pass the whole chain or a single paragraph. Helper exists
 * so the tool-result handler doesn't have to know about the convention.
 */
export function pickLastReasoning(chain: string[] | null | undefined): string | null {
  if (!Array.isArray(chain) || chain.length === 0) return null
  for (let i = chain.length - 1; i >= 0; i--) {
    const p = chain[i]
    if (typeof p === "string" && p.trim().length > 0) return p
  }
  return null
}
