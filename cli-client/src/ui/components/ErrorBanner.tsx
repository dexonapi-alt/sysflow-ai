/**
 * <ErrorBanner> — Stage 4 of plan
 * `2026-05-18-ui-ux-polish-and-action-aware-spinner.md`, audit issue #1.
 *
 * Renders a distinct visual block when a terminal-exit-class error
 * fires (today: only `sysflow_infra`). Replaces the pre-Stage-4 path
 * where `agent.ts` wrote 5+ raw `console.log` lines inline — the
 * same gotcha-104 risk class as the original raw cursor-up writes.
 *
 * Visual:
 *
 *     ▔▔▔ SYSFLOW INFRASTRUCTURE ERROR ▔▔▔
 *
 *     <message>
 *
 *     <hint? (muted)>
 *     ▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁
 *
 * Top + bottom rules use ▔ / ▁ (block-low/high) instead of ═ so
 * the banner reads as a "frame" rather than a heavy horizontal
 * separator. Banner is rendered through Ink's <Static> when present
 * (terminal-exit path — won't change) so it doesn't re-render every
 * frame.
 *
 * Pure presentational; the agent-events reducer owns the state.
 */

import * as React from "react"
import { Box, Text } from "ink"
import { palette } from "../theme.js"

const RULE_TOP = "▔"
const RULE_BOTTOM = "▁"
const DEFAULT_RULE_WIDTH = 40

export interface Props {
  title: string
  message: string
  hint?: string | null
}

export function ErrorBanner({ title, message, hint }: Props): React.ReactElement {
  const ruleTop = RULE_TOP.repeat(3) + " " + title + " " + RULE_TOP.repeat(3)
  const ruleBottom = RULE_BOTTOM.repeat(Math.max(DEFAULT_RULE_WIDTH, ruleTop.length))
  return (
    <Box flexDirection="column" marginTop={1} marginLeft={2}>
      <Text color={palette.error} bold>{ruleTop}</Text>
      <Box marginTop={1}>
        <Text color={palette.warning}>{message}</Text>
      </Box>
      {hint && (
        <Box marginTop={1}>
          <Text color={palette.muted}>{hint}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text color={palette.error}>{ruleBottom}</Text>
      </Box>
    </Box>
  )
}
