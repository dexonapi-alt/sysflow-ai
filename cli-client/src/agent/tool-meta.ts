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
}

export const TOOL_META: Record<string, ToolMeta> = {
  read_file:        { isConcurrencySafe: true,  isReadOnly: true,  abortsSiblingsOnError: false },
  batch_read:       { isConcurrencySafe: true,  isReadOnly: true,  abortsSiblingsOnError: false },
  list_directory:   { isConcurrencySafe: true,  isReadOnly: true,  abortsSiblingsOnError: false },
  search_code:      { isConcurrencySafe: true,  isReadOnly: true,  abortsSiblingsOnError: false },
  search_files:     { isConcurrencySafe: true,  isReadOnly: true,  abortsSiblingsOnError: false },
  web_search:       { isConcurrencySafe: true,  isReadOnly: true,  abortsSiblingsOnError: false },
  file_exists:      { isConcurrencySafe: true,  isReadOnly: true,  abortsSiblingsOnError: false },
  write_file:       { isConcurrencySafe: true,  isReadOnly: false, abortsSiblingsOnError: false },
  edit_file:        { isConcurrencySafe: true,  isReadOnly: false, abortsSiblingsOnError: false },
  create_directory: { isConcurrencySafe: true,  isReadOnly: false, abortsSiblingsOnError: false },
  move_file:        { isConcurrencySafe: false, isReadOnly: false, abortsSiblingsOnError: false },
  delete_file:      { isConcurrencySafe: false, isReadOnly: false, abortsSiblingsOnError: false },
  run_command:      { isConcurrencySafe: false, isReadOnly: false, abortsSiblingsOnError: true  },
  batch_write:      { isConcurrencySafe: true,  isReadOnly: false, abortsSiblingsOnError: false },
}

const DEFAULT_META: ToolMeta = {
  isConcurrencySafe: false,
  isReadOnly: false,
  abortsSiblingsOnError: false,
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
