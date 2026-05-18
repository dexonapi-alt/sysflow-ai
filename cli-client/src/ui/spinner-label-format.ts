/**
 * Stage 2 of plan `2026-05-18-ui-ux-polish-and-action-aware-spinner.md`.
 *
 * Pure formatters that turn tool dispatch state into a one-line
 * spinner label. Closes the user-reported pattern where the
 * `<RichSpinner>` verb cycle (Phase 14: "thinking…" / "weighing
 * options…" / "polishing…") ran on a 3-second timer regardless of
 * what the agent was actually doing — even mid-write.
 *
 * New label resolution priority (composed inside `<AgentStream>`):
 *
 *   1. Explicit phase label set via `spinner.text = …` in agent.ts
 *      (e.g. "asking openrouter-auto…", "retrying after rate limit…")
 *      WINS when no tool is currently running.
 *   2. Per-tool label derived from the in-flight `<ToolCard>` state
 *      via `formatRunningCardsForSpinner` — fires whenever there's
 *      at least one card with `status === "running"`. Overrides the
 *      explicit text because:
 *        - The explicit text is usually a generic placeholder
 *          ("thinking…", "executing 3 tools…") set BEFORE the
 *          tool_start events fire.
 *        - The per-tool label is more informative once cards mount.
 *   3. Verb cycle (idle fallback) — kicks in when both 1 and 2 are
 *      absent, i.e. between dispatch turns waiting on a model
 *      response. Same `<RichSpinner>` cycle as today; this stage
 *      just narrows when it runs.
 *
 * Format conventions:
 *   - Verb-first ("reading", "writing", "editing", "running",
 *     "searching", "listing") to match the verb cycle vocabulary so
 *     the transition between cycle and action reads naturally.
 *   - Path verbatim for single-file ops. Truncated to 40 chars for
 *     run_command + 30 chars for search queries (keeps the spinner
 *     line under typical terminal width).
 *   - Aggregate form for multi-card running batches:
 *       all same tool → "writing 3 files"
 *       mixed         → "running 3 tools"
 *
 * Pure — no I/O, no React. Tested directly.
 */

const MAX_COMMAND_CHARS = 40
const MAX_QUERY_CHARS = 30

/**
 * Per-tool verb prefix used by both single-tool and multi-card
 * aggregations. Keys = canonical tool names (see KNOWN_TOOL_NAMES
 * in tool-meta.ts); values = the human verb to surface.
 *
 * `reason` is intentionally "thinking through it" so the transition
 * from / to the verb cycle's "thinking…" reads as the SAME activity
 * (no jarring vocabulary swap).
 */
const VERB_BY_TOOL: Record<string, string> = {
  read_file: "reading",
  batch_read: "reading",
  write_file: "writing",
  batch_write: "writing",
  edit_file: "editing",
  delete_file: "deleting",
  move_file: "moving",
  create_directory: "creating",
  list_directory: "listing",
  file_exists: "checking",
  search_code: "searching",
  search_files: "searching files",
  web_search: "searching the web",
  run_command: "running",
  reason: "thinking through it",
  check_jobs: "checking jobs",
}

/**
 * Whether a tool is "file-flavoured" — its aggregate form uses the
 * "N files" suffix rather than "N tools". Used by
 * `formatRunningCardsForSpinner` when multiple cards run in parallel
 * and they're all the same file-flavoured tool.
 */
const FILE_TOOLS: ReadonlySet<string> = new Set([
  "read_file",
  "batch_read",
  "write_file",
  "batch_write",
  "edit_file",
  "delete_file",
])

/**
 * Pure: format a single tool dispatch into a spinner label.
 *
 * Falls back to the verb-by-tool prefix alone when args are missing
 * or unrecognised. Unknown tools fall back to the tool name verbatim
 * (better than nothing — at least the user sees what dispatched).
 */
export function formatToolForSpinner(tool: string, args: Record<string, unknown> | undefined): string {
  const verb = VERB_BY_TOOL[tool]
  const path = typeof args?.path === "string" ? args.path : ""

  switch (tool) {
    case "read_file":
      return path ? `${verb} ${path}` : verb
    case "batch_read": {
      const count = Array.isArray(args?.paths) ? args.paths.length : 0
      if (count > 0) return `${verb} ${count} ${count === 1 ? "file" : "files"}`
      return verb
    }
    case "write_file":
      return path ? `${verb} ${path}` : verb
    case "batch_write": {
      const count = Array.isArray(args?.files) ? args.files.length : 0
      if (count > 0) return `${verb} ${count} ${count === 1 ? "file" : "files"}`
      return verb
    }
    case "edit_file":
      return path ? `${verb} ${path}` : verb
    case "delete_file":
      return path ? `${verb} ${path}` : verb
    case "move_file": {
      const from = typeof args?.from === "string" ? args.from : ""
      const to = typeof args?.to === "string" ? args.to : ""
      if (from && to) return `${verb} ${from} → ${to}`
      return verb
    }
    case "create_directory":
      return path ? `${verb} ${path}` : "creating directory"
    case "list_directory":
      return path ? `${verb} ${path}` : verb
    case "file_exists":
      return path ? `${verb} ${path}` : verb
    case "search_code": {
      const pat = typeof args?.pattern === "string" ? args.pattern : ""
      if (!pat) return verb
      return `${verb} for "${truncate(pat, MAX_QUERY_CHARS)}"`
    }
    case "search_files": {
      const q = typeof args?.query === "string" ? args.query : ""
      if (!q) return verb
      return `${verb} for "${truncate(q, MAX_QUERY_CHARS)}"`
    }
    case "web_search": {
      const q = typeof args?.query === "string" ? args.query : ""
      if (!q) return verb
      return `${verb} for "${truncate(q, MAX_QUERY_CHARS)}"`
    }
    case "run_command": {
      const cmd = typeof args?.command === "string" ? args.command : ""
      if (!cmd) return verb
      return `${verb} ${truncate(cmd, MAX_COMMAND_CHARS)}`
    }
    case "reason":
      return verb // "thinking through it"
    case "check_jobs":
      return verb
    default:
      return tool
  }
}

interface RunningCardLike {
  tool: string
  args?: Record<string, unknown>
  status: string
}

/**
 * Pure: pick the best spinner label for a list of in-flight tool
 * cards. Returns null when no cards are running (caller falls back
 * to the explicit spinner text or the verb cycle).
 *
 * - 0 running → null
 * - 1 running → formatToolForSpinner of that single tool
 * - N running, all same file-tool → "writing N files" / "reading N files"
 * - N running, same non-file tool → "running N <tool>s" generic
 * - N running, mixed tools → "running N tools"
 */
export function formatRunningCardsForSpinner(cards: ReadonlyArray<RunningCardLike>): string | null {
  const running = cards.filter((c) => c.status === "running")
  if (running.length === 0) return null
  if (running.length === 1) return formatToolForSpinner(running[0].tool, running[0].args)

  const uniqueTools = new Set(running.map((c) => c.tool))
  if (uniqueTools.size === 1) {
    const tool = running[0].tool
    const count = running.length
    const verb = VERB_BY_TOOL[tool]
    if (verb && FILE_TOOLS.has(tool)) {
      return `${verb} ${count} files`
    }
    if (verb) {
      // Non-file tool with multiple running instances — generic
      // count form. Rare in practice (the cli rarely runs 3 parallel
      // run_command's), but we handle it cleanly.
      return `${verb} ${count} actions`
    }
    return `running ${count} tools`
  }

  return `running ${running.length} tools`
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, Math.max(0, max - 1)) + "…"
}
