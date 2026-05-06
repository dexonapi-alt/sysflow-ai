import * as React from "react"
import { useEffect, useState } from "react"
import { Box, Text } from "ink"
import { palette, tempo } from "../theme.js"
import { Breath } from "../animation/primitives/index.js"

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

interface Props {
  /** Optional override — when set, replaces the cycling verbs. */
  text?: string
}

/**
 * Phase 12 Stage 3: replaces the legacy ora-style braille rotation with
 * a single glyph wrapped in a `<Breath>` pulse. The verb cycling stays
 * — that part of the design (rotating implementation-flavoured verbs
 * every ~3s) reads as progress and is independent of the animation
 * primitive underneath.
 *
 * Visual: `  ●  thinking…`
 *   - The dot breathes between accentDim and accent at activeBpm (60),
 *     which feels like a working pulse without the staccato of dots.
 *   - The verb fades through every 3s.
 *
 * Motion-disabled: Breath collapses to its `to` color (the bright
 * accent), so the dot is steady and the verb still cycles.
 */
export function Spinner({ text }: Props): React.ReactElement {
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
