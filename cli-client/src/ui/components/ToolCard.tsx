/**
 * <ToolCard> — Phase 12 Stage 4: a tool call rendered as a small bordered
 * card instead of a single log line. Three states drive the appearance:
 *
 *   - **running** — accent border, label rendered with `<Shimmer>` so
 *     a moving highlight sweeps left-to-right while the tool is in flight.
 *   - **success** — muted border, settled label, single `<Pulse>` ping
 *     on the transition (success → muted) so the user sees the moment of
 *     completion without ongoing motion.
 *   - **error** — error border, label `<Pulse>` flares warm (warning →
 *     error) on the transition then settles into a steady red-bordered
 *     state. Optional one-line error message rendered underneath.
 *
 * The card is stable in its position once mounted. Stage 4 does NOT
 * unmount cards — they accumulate in the stream until the next "clear"
 * event (typically a new prompt). Window-virtualisation lands in Stage 8.
 *
 * Motion-disabled: Shimmer and Pulse collapse as documented in their
 * primitive files; the card still renders correctly with steady colors.
 */

import * as React from "react"
import { Box, Text } from "ink"
import { palette } from "../theme.js"
import { Shimmer, Pulse } from "../animation/primitives/index.js"
import type { ToolCardState } from "../hooks/useAgentEvents.js"

interface Props {
  card: ToolCardState
}

/**
 * Resolve the visual variant for a given card state. Pure helper so the
 * border-color / glyph mapping is testable and centralised — components
 * elsewhere (off-course modal evidence list, telemetry summary) can
 * reuse it without duplicating the lookup.
 */
export function variantForCardStatus(status: ToolCardState["status"]): {
  borderColor: string
  glyph: string
  glyphColor: string
} {
  switch (status) {
    case "running":
      return { borderColor: palette.accent, glyph: "▸", glyphColor: palette.accent }
    case "success":
      return { borderColor: palette.muted, glyph: "✔", glyphColor: palette.success }
    case "error":
      return { borderColor: palette.error, glyph: "✖", glyphColor: palette.error }
  }
}

export function ToolCard({ card }: Props): React.ReactElement {
  const variant = variantForCardStatus(card.status)

  return (
    <Box
      borderStyle="round"
      borderColor={variant.borderColor}
      paddingX={1}
      flexDirection="column"
      marginLeft={2}
    >
      <Box>
        <Text color={variant.glyphColor}>{variant.glyph}</Text>
        <Text> </Text>
        <CardLabel card={card} />
      </Box>
      {card.status === "error" && card.error && (
        <Box marginTop={0}>
          <Text color={palette.muted}>  {truncateError(card.error)}</Text>
        </Box>
      )}
    </Box>
  )
}

/**
 * Per-status label rendering. Split into its own component so React's
 * reconciler treats the Shimmer / Pulse / steady Text as distinct mount
 * points — switching status from running → success cleanly unmounts the
 * Shimmer (which stops its frame ticks) and mounts a Pulse for the
 * settle ping. No leaked subscriptions.
 */
function CardLabel({ card }: { card: ToolCardState }): React.ReactElement {
  if (card.status === "running") {
    return (
      <Shimmer base={palette.bright} highlight={palette.accent} width={4}>
        {card.label}
      </Shimmer>
    )
  }
  if (card.status === "success") {
    // Pulse triggered once (triggerKey = id, stable) → cubicOut decay
    // from accent → muted. Settled cards stop ticking once decay is done.
    return (
      <Pulse flash={palette.success} settle={palette.muted} triggerKey={card.id}>
        {card.label}
      </Pulse>
    )
  }
  // error
  return (
    <Pulse flash={palette.warning} settle={palette.error} triggerKey={card.id} bold>
      {card.label}
    </Pulse>
  )
}

/** Cap error text to one line for the card; full error stays in the log. */
function truncateError(s: string): string {
  const first = s.split("\n")[0]
  return first.length > 80 ? first.slice(0, 79) + "…" : first
}
