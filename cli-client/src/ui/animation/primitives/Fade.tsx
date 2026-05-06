/**
 * <Fade> — opacity transition for mount/unmount and collapse sequences.
 * Terminal text doesn't have real opacity, so we simulate by lerping
 * the text color toward `palette.muted` for fade-out, or from `muted`
 * to the target color for fade-in.
 *
 * Direction is set at mount and doesn't change — re-mount the component
 * with a new direction prop for a re-fade. `onDone` fires once when the
 * fade lands so callers can trigger an actual unmount after fade-out.
 *
 * Motion-disabled: render the destination color immediately, fire
 * onDone synchronously on the first frame.
 */

import * as React from "react"
import { useEffect, useRef, useState } from "react"
import { Text } from "ink"
import { useFrame, nowMs } from "../use-frame.js"
import { cubicOut } from "../easings.js"
import { lerpHex } from "../color-lerp.js"
import { isMotionEnabled } from "../../state/motion.js"
import { palette } from "../../theme.js"

export type FadeDirection = "in" | "out"

export interface FadeProps {
  /** Mount-fade ("in") or unmount-fade ("out"). Set once at mount. */
  direction: FadeDirection
  /** The visible (post-fade-in or pre-fade-out) color. */
  color: string
  /** Fade duration in ms. Default 300 — quick enough to feel snappy. */
  durationMs?: number
  /** Optional callback fired when the fade completes. */
  onDone?: () => void
  children: string
}

/**
 * Pure shape function. `elapsedMs` is the time since fade started.
 * For `in`: starts at muted, lerps to `color` over `durationMs`.
 * For `out`: starts at `color`, lerps to muted over `durationMs`.
 */
export function computeFadeColor(
  direction: FadeDirection,
  elapsedMs: number,
  durationMs: number,
  color: string,
  mutedColor: string = palette.muted,
): string {
  if (elapsedMs <= 0) return direction === "in" ? mutedColor : color
  if (elapsedMs >= durationMs) return direction === "in" ? color : mutedColor
  const t = cubicOut(elapsedMs / durationMs)
  return direction === "in" ? lerpHex(mutedColor, color, t) : lerpHex(color, mutedColor, t)
}

export function Fade({ direction, color, durationMs = 300, onDone, children }: FadeProps): React.ReactElement {
  const startedAt = useRef<number>(nowMs())
  const fired = useRef<boolean>(false)
  const [paint, setPaint] = useState<string>(() => {
    if (!isMotionEnabled()) return direction === "in" ? color : palette.muted
    return computeFadeColor(direction, 0, durationMs, color)
  })

  // Motion-disabled: fire onDone on the next tick so the parent's
  // useEffect ordering isn't disrupted.
  useEffect(() => {
    if (!isMotionEnabled() && onDone && !fired.current) {
      fired.current = true
      queueMicrotask(onDone)
    }
  }, [])

  useFrame((t) => {
    const elapsed = t - startedAt.current
    setPaint(computeFadeColor(direction, elapsed, durationMs, color))
    if (elapsed >= durationMs && onDone && !fired.current) {
      fired.current = true
      onDone()
    }
  })

  return <Text color={paint}>{children}</Text>
}
