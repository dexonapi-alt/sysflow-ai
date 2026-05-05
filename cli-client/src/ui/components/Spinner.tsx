import * as React from "react"
import { useEffect, useState } from "react"
import { Box, Text } from "ink"
import { palette, glyphs } from "../theme.js"

const VERBS = [
  "thinking",
  "implementing",
  "wiring up",
  "verifying",
  "polishing",
  "reasoning",
  "drafting",
] as const

const FRAME_MS = 80
const VERB_MS = 3000

interface Props {
  /** Optional override — when set, replaces the cycling verbs. */
  text?: string
}

/**
 * Animated spinner with verb cycling. Replaces the generic `ora` "thinking..."
 * by rotating through implementation-flavoured verbs every ~3s, so a long
 * agent run reads like progress instead of a frozen status.
 */
export function Spinner({ text }: Props): React.ReactElement {
  const [frame, setFrame] = useState(0)
  const [verbIndex, setVerbIndex] = useState(0)

  useEffect(() => {
    const t = setInterval(() => setFrame((f) => (f + 1) % glyphs.spinner.length), FRAME_MS)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    if (text) return
    const t = setInterval(() => setVerbIndex((i) => (i + 1) % VERBS.length), VERB_MS)
    return () => clearInterval(t)
  }, [text])

  const label = text ?? `${VERBS[verbIndex]}…`

  return (
    <Box>
      <Text color={palette.accent}>  {glyphs.spinner[frame]} </Text>
      <Text color={palette.muted}>{label}</Text>
    </Box>
  )
}
