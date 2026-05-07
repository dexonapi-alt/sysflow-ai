/**
 * <RichSpinner> — Phase 14 Stage 3: replaces the single-glyph breath
 * spinner with a frame-cycled swirl + a live status overlay.
 *
 * Three regions on one row:
 *
 *   ✢   thinking…   (0:42 · ↑ 12.3k)
 *   ─   ───────       ──────────────
 *   glyph  verb       overlay
 *
 *   - **Glyph**: ONE character at a time, swapped on a breath cadence
 *     so the eye reads a rotation: `✢ → ✺ → ✣ → ✤ → ✢ …`. Each glyph
 *     gets its own colour (`SPINNER_COLORS`) so the swap is visible
 *     even at small sizes — the row reads as a single colour-shifting
 *     star, not as "an icon".
 *   - **Verb**: cycles through `VERBS` every 3s. Same behaviour as the
 *     prior `<Spinner>`. An optional `text` prop overrides the cycle (used
 *     by callers like `<App>` to surface a one-off "loading…" label).
 *   - **Overlay**: muted parens block with `(elapsed · ↑ tokens)`. The
 *     elapsed counter resets when the spinner mounts. Tokens are passed
 *     in via the `tokens` prop — the parent (AgentStream eventually)
 *     accumulates the running estimate from `cliEstimateTokens` and
 *     hands it down. Hidden when neither value is available.
 *
 * Motion-disabled: glyph stays on index 0 (the brand-accent star),
 * verb still cycles every 3s.
 */

import * as React from "react"
import { useEffect, useRef, useState } from "react"
import { Box, Text } from "ink"
import { palette, tempo } from "../theme.js"
import { useFrame, nowMs } from "../animation/use-frame.js"
import { isMotionEnabled } from "../state/motion.js"
import { formatElapsed } from "./LiveStatusBar.js"

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

/** Glyph set — chosen for visual similarity (all 4-pointed star shapes)
 *  so the swap reads as one motif rotating, not four glyphs flickering. */
export const SPINNER_GLYPHS = ["✢", "✺", "✣", "✤"] as const

/** Colour per glyph index — all in the cool family (purple → teal → blue
 *  → green) so the rotation reads as a calm hue-shift rather than a
 *  warning or alert. Each entry stays distinct enough that the eye reads
 *  each frame change even on terminals that crush mid-luminance hues.
 *  MUST stay length-aligned with `SPINNER_GLYPHS`. */
export const SPINNER_COLORS = [
  palette.accent,   // ✢ purple
  palette.tool,     // ✺ teal
  palette.info,     // ✣ blue
  palette.success,  // ✤ green
] as const

interface Props {
  /** Optional override — when set, replaces the cycling verbs. */
  text?: string
  /** Phase 14 Stage 3: estimated tokens accumulated this turn. Hidden when 0/undefined. */
  tokens?: number
}

/**
 * Pure: which glyph is primary at this wall-clock millisecond, given a
 * tempo in bpm and the total glyph count. Rotates one full cycle per
 * breath period. Exported so the test asserts the swirl deterministically.
 */
export function pickPrimaryGlyph(nowMs: number, bpm: number, glyphCount: number): number {
  if (glyphCount <= 0) return 0
  if (bpm <= 0) return 0
  const periodMs = 60_000 / bpm
  const t = (nowMs % periodMs) / periodMs
  return Math.floor(t * glyphCount) % glyphCount
}

/**
 * Pure: format a token count as a compact string. Sign-prefixed for
 * deltas. Examples:
 *   12 → "12"
 *   1500 → "1.5k"
 *   12_300 → "12.3k"
 *   1_234_567 → "1.2M"
 */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return "0"
  const abs = Math.abs(n)
  if (abs < 1_000) return String(Math.round(n))
  if (abs < 1_000_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`
}

export function RichSpinner({ text, tokens }: Props): React.ReactElement {
  const [verbIndex, setVerbIndex] = useState(0)
  // Per-mount elapsed clock. The parent (AgentStream) re-mounts this
  // component implicitly when the spinner state transitions from null →
  // non-null, so tracking startedAt at mount time gives us the "this
  // turn's elapsed" without needing event coordination.
  const startedAtRef = useRef<number>(nowMs())
  const [now, setNow] = useState<number>(() => nowMs())

  useEffect(() => {
    if (text) return
    const t = setInterval(() => setVerbIndex((i) => (i + 1) % VERBS.length), VERB_MS)
    return () => clearInterval(t)
  }, [text])

  useFrame((t) => setNow(t))

  const label = text ?? `${VERBS[verbIndex]}…`
  const primaryIdx = isMotionEnabled() ? pickPrimaryGlyph(now, tempo.activeBpm, SPINNER_GLYPHS.length) : 0
  const elapsedMs = now - startedAtRef.current
  const showOverlay = elapsedMs >= 1000 || (tokens != null && tokens > 0)

  return (
    <Box>
      <Text>  </Text>
      <Text color={SPINNER_COLORS[primaryIdx]}>{SPINNER_GLYPHS[primaryIdx]}</Text>
      <Text color={palette.muted}>  {label}</Text>
      {showOverlay && (
        <>
          <Text color={palette.muted}>  </Text>
          <Text color={palette.muted}>(</Text>
          {elapsedMs >= 1000 && <Text color={palette.muted}>{formatElapsed(elapsedMs)}</Text>}
          {elapsedMs >= 1000 && tokens != null && tokens > 0 && <Text color={palette.muted}> · </Text>}
          {tokens != null && tokens > 0 && (
            <>
              <Text color={palette.muted}>↑ </Text>
              <Text color={palette.muted}>{formatTokens(tokens)}</Text>
            </>
          )}
          <Text color={palette.muted}>)</Text>
        </>
      )}
    </Box>
  )
}
