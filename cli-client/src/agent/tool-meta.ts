/**
 * Tool metadata: concurrency safety, read-only flag, sibling-abort behaviour.
 *
 * Single source of truth for the concurrency model used by executor.ts.
 * Replaces the heuristic 'if tool === run_command run sequentially'
 * that was sprinkled through batch execution.
 *
 * Each tool declares:
 *   - isConcurrencySafe: can run in parallel with siblings (different paths)
 *   - isReadOnly: doesn't modify project state
 *   - abortsSiblingsOnError: a failure should cancel sibling tools in the batch
 */

export interface ToolMeta {
  isConcurrencySafe: boolean
  isReadOnly: boolean
  abortsSiblingsOnError: boolean
  /** Default permission decision for this tool when no rule matches. */
  defaultPermission: "allow" | "ask" | "deny"
}

export const TOOL_META: Record<string, ToolMeta> = {
  read_file:        { isConcurrencySafe: true,  isReadOnly: true,  abortsSiblingsOnError: false, defaultPermission: "allow" },
  batch_read:       { isConcurrencySafe: true,  isReadOnly: true,  abortsSiblingsOnError: false, defaultPermission: "allow" },
  list_directory:   { isConcurrencySafe: true,  isReadOnly: true,  abortsSiblingsOnError: false, defaultPermission: "allow" },
  search_code:      { isConcurrencySafe: true,  isReadOnly: true,  abortsSiblingsOnError: false, defaultPermission: "allow" },
  search_files:     { isConcurrencySafe: true,  isReadOnly: true,  abortsSiblingsOnError: false, defaultPermission: "allow" },
  web_search:       { isConcurrencySafe: true,  isReadOnly: true,  abortsSiblingsOnError: false, defaultPermission: "allow" },
  file_exists:      { isConcurrencySafe: true,  isReadOnly: true,  abortsSiblingsOnError: false, defaultPermission: "allow" },
  // Authoring tools auto-allow: scaffolding 30 files shouldn't take 30
  // permission prompts. The agent works on a project the user explicitly
  // pointed it at, and every change is git-snapshotted before the batch
  // runs (see executeToolsBatch). The user gates the *agent run*, not
  // each line of code it writes.
  write_file:       { isConcurrencySafe: true,  isReadOnly: false, abortsSiblingsOnError: false, defaultPermission: "allow" },
  edit_file:        { isConcurrencySafe: true,  isReadOnly: false, abortsSiblingsOnError: false, defaultPermission: "allow" },
  create_directory: { isConcurrencySafe: true,  isReadOnly: false, abortsSiblingsOnError: false, defaultPermission: "allow" },
  // move/delete are destructive (not authoring) — keep them gated.
  move_file:        { isConcurrencySafe: false, isReadOnly: false, abortsSiblingsOnError: false, defaultPermission: "ask" },
  delete_file:      { isConcurrencySafe: false, isReadOnly: false, abortsSiblingsOnError: false, defaultPermission: "ask" },
  // Shell commands stay gated — that's the side-effect surface that can
  // touch the network, install packages, or escape the project dir.
  run_command:      { isConcurrencySafe: false, isReadOnly: false, abortsSiblingsOnError: true,  defaultPermission: "ask" },
  batch_write:      { isConcurrencySafe: true,  isReadOnly: false, abortsSiblingsOnError: false, defaultPermission: "allow" },
  // Phase 5: pure thinking — no permission prompt, no side effects.
  reason:           { isConcurrencySafe: true,  isReadOnly: true,  abortsSiblingsOnError: false, defaultPermission: "allow" },
  // Phase 7: pure local poll of the in-memory JobRegistry.
  check_jobs:       { isConcurrencySafe: true,  isReadOnly: true,  abortsSiblingsOnError: false, defaultPermission: "allow" },
}

const DEFAULT_META: ToolMeta = {
  isConcurrencySafe: false,
  isReadOnly: false,
  abortsSiblingsOnError: false,
  defaultPermission: "ask",
}

export function getToolMeta(tool: string): ToolMeta {
  return TOOL_META[tool] ?? DEFAULT_META
}

/**
 * Stage 1 of plan 2026-05-16-server-hardening-and-error-source-distinction.md.
 *
 * Canonical set of tool names the cli executor knows how to dispatch.
 * Derived from TOOL_META keys so the set stays in sync with the
 * registry. Used by the validation gate (`isKnownTool`) before any
 * tool call leaves the cli — closes the bug where the agent emitted
 * a null/hallucinated tool name, the cli rendered `▸ unknown {}`, and
 * the server crashed with a Postgres NOT NULL violation on `tool`.
 */
export const KNOWN_TOOL_NAMES: ReadonlySet<string> = new Set(Object.keys(TOOL_META))

/**
 * Pure: returns true when `tool` is a non-empty string in
 * `KNOWN_TOOL_NAMES`. Null / undefined / empty / unknown → false.
 */
export function isKnownTool(tool: unknown): tool is string {
  return typeof tool === "string" && tool.length > 0 && KNOWN_TOOL_NAMES.has(tool)
}

export interface ToolCallEntry {
  id: string
  tool: string
  args: Record<string, unknown>
}

/**
 * Split a batch of tool calls into concurrency-safe parallel groups + a serial
 * tail. Order within each group is preserved.
 *
 * Returns:
 *   - parallel: tools that can run via Promise.allSettled in one shot
 *   - serial:   tools that must run one-at-a-time, in order, after the parallel batch
 */
export function partitionToolCalls(tools: ToolCallEntry[]): { parallel: ToolCallEntry[]; serial: ToolCallEntry[] } {
  const parallel: ToolCallEntry[] = []
  const serial: ToolCallEntry[] = []
  for (const tc of tools) {
    if (getToolMeta(tc.tool).isConcurrencySafe) parallel.push(tc)
    else serial.push(tc)
  }
  return { parallel, serial }
}

/** Does the batch contain any tool whose error should cancel siblings? */
export function batchHasSiblingAborter(tools: ToolCallEntry[]): boolean {
  return tools.some((tc) => getToolMeta(tc.tool).abortsSiblingsOnError)
}

/**
 * Group tool calls so same-file write/edit operations run serially while
 * different-file ops still parallelise.
 *
 * `edit_file` and `write_file` are individually concurrency-safe (they don't
 * trigger sibling aborts or share global state with other tools), but two
 * edits targeting the SAME path are NOT safe to run in parallel — each
 * search/replace operates on the file content as it found it, so two
 * concurrent edits race and the second one's search either fails to match
 * or overwrites the first one's changes. The agent surfaces this as
 * "I tried multiple times but the file isn't being updated".
 *
 * Returns an array of groups. Within each group, items run sequentially.
 * Across groups, items run in parallel. Tools without a `path` (read,
 * search, run_command, etc.) get a group of one — same parallel semantics
 * as before.
 */
export function groupForParallelExecution(tools: ToolCallEntry[]): ToolCallEntry[][] {
  const byPath = new Map<string, ToolCallEntry[]>()
  const standalone: ToolCallEntry[][] = []

  for (const tc of tools) {
    const isPathMutation = tc.tool === "write_file" || tc.tool === "edit_file"
    const filePath = isPathMutation ? (tc.args.path as string | undefined) : undefined
    if (!filePath) {
      standalone.push([tc])
      continue
    }
    const existing = byPath.get(filePath)
    if (existing) {
      existing.push(tc)
    } else {
      byPath.set(filePath, [tc])
    }
  }

  return [...standalone, ...byPath.values()]
}

// ─── Stage 1 of accountability-and-parallel-execution-sequencing plan ───
//
// Parallel batch cap. The agent's `tools[]` can carry N parallel calls
// in one response (we've seen 11 in user-reported repros). Without a
// cap, the cli's executor fires all N at once and ships one combined
// tool_result — the agent never reasons between batches, never reads
// back what it wrote, and can author `src/index.ts` (consumer) in the
// SAME turn as `src/routes/auth.ts` (producer), leaving the import
// sanitizer to silently strip the unresolved reference.
//
// Stage 1 enforces a per-turn cap. When the agent emits more than `cap`
// tools, the cli executes the first `cap` AND defers the rest with a
// synthetic `batch_cap_enforced` failure result so the agent's next
// turn sees the deferral + the prior batch's outcomes + can reason
// before re-emitting.

export type RepoState = "empty" | "small" | "existing-small" | "existing-large" | null

/**
 * Default cap. Empty / small / existing-small repos cap at 3 — the
 * common case for fresh scaffolds where ordering + per-file
 * accountability matter most. existing-large gets a relaxed cap
 * because edits across a known codebase are more likely to be wide
 * and the agent's existing context is richer.
 *
 * Kept as constants (not flags) for v1 — flag plumbing is a separate
 * micro-PR if telemetry shows we need tuning.
 */
export const BATCH_CAP_DEFAULT = 3
export const BATCH_CAP_EXISTING_LARGE = 5

/**
 * Resolve the cap for this run based on the project-init brief's
 * classified `repoState`. Falls back to `BATCH_CAP_DEFAULT` when the
 * classifier didn't fire (null) or for the smaller-repo states.
 */
export function resolveBatchCap(repoState: RepoState): number {
  if (repoState === "existing-large") return BATCH_CAP_EXISTING_LARGE
  return BATCH_CAP_DEFAULT
}

export interface BatchCapSplit {
  /** First `cap` tools — to be executed this turn. */
  executed: ToolCallEntry[]
  /** Tools beyond `cap` — synthesise deferral results, agent re-emits next turn. */
  deferred: ToolCallEntry[]
}

/**
 * Pure: split a batch into the executed prefix + deferred suffix.
 * When `tools.length <= cap` (or cap <= 0), returns the whole batch
 * as `executed` with an empty `deferred`.
 */
export function applyBatchCap(tools: ReadonlyArray<ToolCallEntry>, cap: number): BatchCapSplit {
  if (cap <= 0 || tools.length <= cap) {
    return { executed: [...tools], deferred: [] }
  }
  return { executed: tools.slice(0, cap), deferred: tools.slice(cap) }
}

/**
 * Build the synthetic failure result the cli attaches for each
 * deferred tool. The agent sees this in its next tool_result payload
 * alongside the executed tools' real results and can decide whether
 * to re-issue the deferred tools, revise the plan, or stop.
 *
 * The `_errorCategory: "batch_cap_enforced"` lets the server's
 * existing error-classification path treat this as a recovery
 * situation (forced-error-reasoning Stage 3) rather than a hard
 * failure.
 */
export function buildBatchCapDeferralResult(
  toolName: string,
  batchSize: number,
  cap: number,
): Record<string, unknown> {
  return {
    error: `Batch cap enforced: this turn carried ${batchSize} tool calls but the cap is ${cap}. The first ${cap} tools were executed; this tool (${toolName}) was DEFERRED so you can reason about the prior batch's outcomes before re-issuing. READ the executed tools' results carefully, then RE-EMIT the deferred tools in your next response if you still want them — or revise the plan if the results warrant.`,
    success: false,
    _errorCategory: "batch_cap_enforced",
    _deferred: true,
  }
}
