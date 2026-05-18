/**
 * <StreamPreview> — Stage 5 of plan
 * `2026-05-18-ui-ux-polish-and-action-aware-spinner.md`, audit issue #7.
 *
 * Renders the most-recent N lines from a running `run_command`'s
 * stdout+stderr stream, in chronological order, indented under the
 * running ActionCard. Replaces the pre-Stage-5 silence — a long
 * `npm install` used to leave the user staring at the spinner for
 * 30+ seconds with NO visibility into progress.
 *
 * Visual:
 *
 *     ● Bash(npm install)
 *       ⌗ added 3 packages, audited 47 packages in 4s
 *       ⌗ 0 vulnerabilities
 *       ⌗ npm notice New minor version of npm available...
 *
 * The `⌗` glyph signals "live stream content" (distinct from `⎿`
 * which is the error-tail glyph on ActionCard). Lines are muted
 * because the active surface is the ActionCard above; the stream
 * is supplementary detail, not the primary signal.
 *
 * Cleared on the next `tool_end` event (the run_command settling)
 * via the reducer. No explicit dismiss action.
 *
 * Pure presentational — the reducer owns the state.
 */

import * as React from "react"
import { Box, Text } from "ink"
import { palette } from "../theme.js"

export interface Props {
  lines: ReadonlyArray<string>
}

/**
 * Stage 5: per-line max width for the stream preview. Lines longer
 * than this truncate with an ellipsis. Tuned to read comfortably on
 * 80-col terminals (allowing for the 4-col indent + glyph + space).
 */
const MAX_LINE_CHARS = 70

/**
 * Pure: clean a stream line for display. Strips trailing whitespace,
 * collapses tabs to single spaces, and truncates to MAX_LINE_CHARS.
 *
 * Exported for direct tests.
 */
export function formatStreamLine(raw: string): string {
  if (typeof raw !== "string") return ""
  const cleaned = raw.replace(/\t/g, " ").replace(/\s+$/g, "")
  if (cleaned.length <= MAX_LINE_CHARS) return cleaned
  return cleaned.slice(0, Math.max(0, MAX_LINE_CHARS - 1)) + "…"
}

export function StreamPreview({ lines }: Props): React.ReactElement | null {
  if (lines.length === 0) return null
  return (
    <Box flexDirection="column" marginLeft={4}>
      {lines.map((raw, i) => (
        <Box key={i}>
          <Text color={palette.muted}>⌗ </Text>
          <Text color={palette.muted}>{formatStreamLine(raw)}</Text>
        </Box>
      ))}
    </Box>
  )
}
