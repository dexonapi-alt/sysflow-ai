/**
 * <ActionCard> — Phase 14 Stage 2: Claude-style single-line tool render.
 *
 * Replaces the bordered <ToolCard> from Phase 12 Stage 4. Drops the
 * round-bordered chrome in favour of a single line:
 *
 *   ● Verb(target)
 *
 * Where the bullet color follows the lifecycle (accent breathing while
 * running, muted on settle, error red on failure) and `Verb(target)`
 * is derived from the tool name + args via the pure helpers below.
 *
 * Optional one-line error renders underneath with a `⎿` connector:
 *
 *   ✖ Update(src/index.ts)
 *     ⎿  ENOENT: no such file
 *
 * No surrounding box, no per-card background fill. The visual chrome
 * comes from indentation + bullet colour + the connector glyph — which
 * reads as significantly more dense and polished than the previous
 * bordered card per the Phase 14 plan's reference (Claude Code's
 * `● Verb(...)` format).
 *
 * Pure helpers — exported and unit-tested directly:
 *   - `verbFor(tool)` — tool-name → display Verb
 *   - `formatActionHeader(tool, args)` — produces the `Verb(target)` string
 *   - `truncateTarget(s, max)` — ellipsis-cap for long paths/commands
 */

import * as React from "react"
import { Box, Text } from "ink"
import { palette } from "../theme.js"
import { Breath } from "../animation/primitives/index.js"
import type { ToolCardState } from "../hooks/useAgentEvents.js"

interface Props {
  card: ToolCardState
}

/**
 * Display verb for a given tool. Maps the wire-format tool names to a
 * human verb that reads naturally in `Verb(target)` form. Unknown tools
 * fall back to the tool name capitalised so the card is never blank.
 *
 * The mapping is intentionally Claude-style — `Bash` for shell, `Update`
 * for an in-place edit, `Write` for a fresh file, `Read` for a fetch,
 * `Search` for grep/find/web — so the user reads the verb the same way
 * they would in Claude Code.
 */
export function verbFor(tool: string): string {
  switch (tool) {
    case "run_command":      return "Bash"
    case "write_file":       return "Write"
    case "edit_file":        return "Update"
    case "read_file":        return "Read"
    case "batch_read":       return "Read"
    case "batch_write":      return "Write"
    case "search_files":     return "Search"
    case "search_code":      return "Search"
    case "list_directory":   return "List"
    case "create_directory": return "Mkdir"
    case "delete_file":      return "Delete"
    case "move_file":        return "Move"
    case "file_exists":      return "Check"
    case "web_search":       return "WebSearch"
    case "reason":           return "Reason"
    default: {
      // Unknown tool — capitalise first char of name as a safe fallback.
      if (!tool) return "Tool"
      return tool.charAt(0).toUpperCase() + tool.slice(1)
    }
  }
}

const TARGET_MAX = 80

/**
 * Compose the `Verb(target)` header string from a tool name + its args.
 * Pure: no rendering, no chalk, no Ink. Returns a plain string the
 * component then paints.
 *
 * Target extraction priority by tool:
 *   - run_command:           args.command
 *   - write/read/edit/etc.:  args.path / file_path / filePath
 *   - move_file:             "from → to"
 *   - search_*:              args.pattern / query / glob
 *   - web_search:            args.query
 *   - batch_write:           "<n> files"
 *   - default:               the path-ish field if we can guess one
 */
export function formatActionHeader(tool: string, args: Record<string, unknown> | undefined): string {
  const verb = verbFor(tool)
  const target = extractTarget(tool, args ?? {})
  if (!target) return verb
  return `${verb}(${truncateTarget(target, TARGET_MAX)})`
}

/** Cap a long target string with an ellipsis at the byte limit. */
export function truncateTarget(s: string, max: number = TARGET_MAX): string {
  if (typeof s !== "string") return ""
  if (s.length <= max) return s
  return s.slice(0, Math.max(0, max - 1)) + "…"
}

function extractTarget(tool: string, args: Record<string, unknown>): string {
  switch (tool) {
    case "run_command":
      return (args.command as string) ?? ""
    case "move_file": {
      const from = (args.from as string) ?? ""
      const to = (args.to as string) ?? ""
      if (from && to) return `${from} → ${to}`
      return from || to
    }
    case "search_code":
      return (args.pattern as string) ?? ""
    case "search_files":
      return (args.query as string) ?? (args.glob as string) ?? ""
    case "web_search":
      return (args.query as string) ?? ""
    case "batch_write": {
      const files = (args.files as Array<{ path?: string }> | undefined) ?? []
      if (files.length === 1 && files[0]?.path) return files[0].path
      return `${files.length} files`
    }
    default: {
      const p = (args.path as string)
        ?? (args.file_path as string)
        ?? (args.filePath as string)
      return p ?? ""
    }
  }
}

export function ActionCard({ card }: Props): React.ReactElement {
  const header = formatActionHeader(card.tool, card.args)
  return (
    <Box flexDirection="column" marginLeft={2}>
      <Box>
        <Bullet status={card.status} />
        <Text> </Text>
        <HeaderText status={card.status} text={header} />
      </Box>
      {card.status === "error" && card.error && (
        <Box marginLeft={2}>
          <Text color={palette.muted}>⎿  </Text>
          <Text color={palette.error}>{truncateTarget(firstLine(card.error), 100)}</Text>
        </Box>
      )}
    </Box>
  )
}

function Bullet({ status }: { status: ToolCardState["status"] }): React.ReactElement {
  if (status === "running") {
    return <Breath from={palette.accentDim} to={palette.accent}>●</Breath>
  }
  if (status === "success") {
    return <Text color={palette.muted}>●</Text>
  }
  return <Text color={palette.error}>●</Text>
}

function HeaderText({ status, text }: { status: ToolCardState["status"]; text: string }): React.ReactElement {
  if (status === "error") {
    return <Text color={palette.bright} bold>{text}</Text>
  }
  if (status === "running") {
    return <Text color={palette.bright}>{text}</Text>
  }
  return <Text color={palette.muted}>{text}</Text>
}

function firstLine(s: string): string {
  const i = s.indexOf("\n")
  return i === -1 ? s : s.slice(0, i)
}
