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
