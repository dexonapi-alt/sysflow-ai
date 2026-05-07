/**
 * Phase 14 Stage 3: `<Spinner>` is now an alias for `<RichSpinner>` so
 * existing call sites (`<App>`, `<AgentStream>`) automatically get the
 * 4-glyph swirl + elapsed/tokens overlay without any import changes.
 *
 * The single-glyph breath spinner from Phase 12 Stage 3 is preserved
 * as `<MiniSpinner>` for one-cell slots where the swirl would be
 * overkill (e.g. inline status notes, future modal headers). The
 * `LiveStatusBar` doesn't import from here — it has its own inline
 * breath glyph, untouched.
 */

import * as React from "react"
import { useEffect, useState } from "react"
import { Box, Text } from "ink"
import { palette, tempo } from "../theme.js"
import { Breath } from "../animation/primitives/index.js"

export { RichSpinner as Spinner } from "./RichSpinner.js"

const VERBS = [
  "thinking",
  "implementing",
  "wiring up",
  "verifying",
  "polishing",
  "reasoning",
  "drafting",
] as const

const VERB_MS = 3000

interface MiniProps {
  /** Optional override — when set, replaces the cycling verbs. */
  text?: string
}

/**
 * `<MiniSpinner>` — single-glyph breath. The Phase 12 spinner shape,
 * preserved here for low-density slots.
 */
export function MiniSpinner({ text }: MiniProps): React.ReactElement {
  const [verbIndex, setVerbIndex] = useState(0)

  useEffect(() => {
    if (text) return
    const t = setInterval(() => setVerbIndex((i) => (i + 1) % VERBS.length), VERB_MS)
    return () => clearInterval(t)
  }, [text])

  const label = text ?? `${VERBS[verbIndex]}…`

  return (
    <Box>
      <Text>  </Text>
      <Breath from={palette.accentDim} to={palette.accent} bpm={tempo.activeBpm}>●</Breath>
      <Text color={palette.muted}> {label}</Text>
    </Box>
  )
}
