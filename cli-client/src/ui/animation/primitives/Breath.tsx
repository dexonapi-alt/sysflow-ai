/**
 * <Breath> — continuous color-pulse primitive for the Phase 12 living-CLI
 * design language. Wraps a single line of text and shifts its color along
 * a two-stop gradient at a configurable bpm (default `tempo.activeBpm`).
 *
 * Composition rule: ONE breath per visible region. Stacking breaths with
 * different tempos in the same line of sight reads as chaos, not life.
 * Use `<Breath>` for the badge OR the spinner OR the modal header — not
 * all three at once.
 *
 * Motion-disabled mode: render the child with the `to` color (the "settled"
 * color, not the midpoint) so the static frame matches the pose the user
 * sees most often (peak intensity = active state).
 */

import * as React from "react"
import { useState } from "react"
import { Text } from "ink"
import { useFrame, nowMs } from "../use-frame.js"
import { breathAt } from "../easings.js"
import { lerpHex } from "../color-lerp.js"
import { isMotionEnabled } from "../../state/motion.js"
import { tempo as defaultTempo } from "../../theme.js"

export interface BreathProps {
  /** Color at the trough of the breath cycle (low intensity). */
  from: string
  /** Color at the peak of the breath cycle (high intensity). */
  to: string
  /** Beats per minute. Defaults to `tempo.activeBpm` (60). */
  bpm?: number
  /** Optional bold modifier applied to the rendered Text. */
  bold?: boolean
  children: string
}

/**
 * Pure shape function: given a wall-clock millisecond + bpm + endpoints,
 * return the breath-shaped hex color the component should render this frame.
 * Exported for unit tests so the visual contract is asserted directly
 * instead of via Ink rendering.
 */
export function computeBreathColor(nowMs: number, bpm: number, from: string, to: string): string {
  const t = breathAt(nowMs, bpm)
  return lerpHex(from, to, t)
}

export function Breath({ from, to, bpm = defaultTempo.activeBpm, bold, children }: BreathProps): React.ReactElement {
  // Initialise to the settled (`to`) color so the very first paint matches
  // motion-disabled mode — no "flash from cold" on mount.
  const [color, setColor] = useState<string>(() => isMotionEnabled() ? computeBreathColor(nowMs(), bpm, from, to) : to)

  useFrame((t) => setColor(computeBreathColor(t, bpm, from, to)))

  return <Text color={color} bold={bold}>{children}</Text>
}
