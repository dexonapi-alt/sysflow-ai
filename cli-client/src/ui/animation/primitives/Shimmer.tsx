/**
 * <Shimmer> — moving highlight sweeping across a single line of text.
 * Used on running tool cards to communicate "this is in flight" without
 * the noise of a spinner. Cycle period defaults to 1.5s; the highlight
 * moves left-to-right and wraps back to start.
 *
 * Each character gets a color blended from the base color toward the
 * highlight color, weighted by how close the character is to the
 * sweep's current position. The blend uses a narrow gaussian-ish
 * falloff so only ~3-4 chars at a time look "lit".
 *
 * Motion-disabled: render every char in the base color, no sweep.
 */

import * as React from "react"
import { useState } from "react"
import { Text } from "ink"
import { useFrame, nowMs } from "../use-frame.js"
import { lerpHex } from "../color-lerp.js"
import { isMotionEnabled } from "../../state/motion.js"

export interface ShimmerProps {
  /** Base color for all characters when not under the highlight. */
  base: string
  /** Color the highlight peaks at. */
  highlight: string
  /** Full sweep duration in ms. Default 1500ms = a calm, alive cadence. */
  periodMs?: number
  /** Width of the highlight in characters (FWHM-ish). Default 3. */
  width?: number
  children: string
}

/**
 * Pure shape function: given (text, time, period, width), return the
 * per-character color array the renderer should paint. Exported for
 * unit tests; the component just maps these into nested Text nodes.
 */
export function computeShimmerColors(
  text: string,
  nowMs: number,
  periodMs: number,
  width: number,
  base: string,
  highlight: string,
): string[] {
  if (text.length === 0) return []
  const phase = (nowMs % periodMs) / periodMs       // 0..1
  const cursor = phase * text.length                // current bright-spot column
  const colors: string[] = new Array(text.length)
  for (let i = 0; i < text.length; i++) {
    // Distance from this char to the sweep cursor, in characters.
    const dist = Math.abs(i - cursor)
    // Gaussian-ish falloff — `width` controls the FWHM. clamp at 1.
    const intensity = Math.max(0, 1 - (dist * dist) / (width * width))
    colors[i] = lerpHex(base, highlight, intensity)
  }
  return colors
}

export function Shimmer({
  base,
  highlight,
  periodMs = 1500,
  width = 3,
  children,
}: ShimmerProps): React.ReactElement {
  const [colors, setColors] = useState<string[]>(() =>
    isMotionEnabled()
      ? computeShimmerColors(children, nowMs(), periodMs, width, base, highlight)
      : new Array(children.length).fill(base),
  )

  useFrame((t) => {
    setColors(computeShimmerColors(children, t, periodMs, width, base, highlight))
  })

  // Render each character with its own color. Ink concatenates adjacent
  // <Text> nodes inline so the result reads as one line.
  return (
    <Text>
      {Array.from(children).map((ch, i) => (
        <Text key={i} color={colors[i] ?? base}>{ch}</Text>
      ))}
    </Text>
  )
}
