/**
 * <Pulse> — single-shot color pulse for discrete events. Used for success
 * pings (write_file completed), error flares (tool failure), step
 * transitions (chunk-plan arrived). Decays via cubicOut from `flash` →
 * `settle` over `durationMs` then stays at `settle` forever.
 *
 * Re-pulse: change the `triggerKey` prop. Each new key value restarts the
 * decay from t=0. Useful for "every chunk-plan arrival" pulses where the
 * key is the chunk index.
 *
 * Motion-disabled: render the settled color immediately, no decay.
 */

import * as React from "react"
import { useEffect, useRef, useState } from "react"
import { Text } from "ink"
import { useFrame, nowMs } from "../use-frame.js"
import { cubicOut } from "../easings.js"
import { lerpHex } from "../color-lerp.js"
import { isMotionEnabled } from "../../state/motion.js"

export interface PulseProps {
  /** Color at t=0 (the moment of the event). */
  flash: string
  /** Color the pulse decays toward. */
  settle: string
  /** Decay duration. Default 600ms — long enough to be felt, short enough
   *  not to overlap with the next event in a busy run. */
  durationMs?: number
  /** Change to re-trigger the pulse from t=0. Initial value triggers once on mount. */
  triggerKey?: string | number
  /** Optional bold modifier applied to the rendered Text. */
  bold?: boolean
  children: string
}

/**
 * Pure shape function: given the millis-since-trigger and the duration,
 * return the lerped color this frame. `t > durationMs` returns the
 * settled color; pre-trigger negative values return the flash color.
 */
export function computePulseColor(elapsedMs: number, durationMs: number, flash: string, settle: string): string {
  if (elapsedMs <= 0) return flash
  if (elapsedMs >= durationMs) return settle
  const t = cubicOut(elapsedMs / durationMs)
  return lerpHex(flash, settle, t)
}

export function Pulse({
  flash,
  settle,
  durationMs = 600,
  triggerKey,
  bold,
  children,
}: PulseProps): React.ReactElement {
  const startedAt = useRef<number>(nowMs())
  const [color, setColor] = useState<string>(() => isMotionEnabled() ? flash : settle)

  // Reset the decay clock whenever the trigger changes (re-pulse).
  useEffect(() => {
    startedAt.current = nowMs()
    if (isMotionEnabled()) setColor(flash)
    else setColor(settle)
  }, [triggerKey])

  useFrame((t) => {
    setColor(computePulseColor(t - startedAt.current, durationMs, flash, settle))
  })

  return <Text color={color} bold={bold}>{children}</Text>
}
