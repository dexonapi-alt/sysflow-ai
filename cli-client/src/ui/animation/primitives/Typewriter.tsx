/**
 * <Typewriter> — char-by-char text reveal with natural pauses on
 * punctuation. Default 250wpm (≈ 24 chars/sec) which reads like fluent
 * writing rather than a slow ticker. Pauses extend at `,` `:` `;` `…`
 * and even longer at `.` `!` `?` `\n` so the cadence feels read, not
 * spelled out.
 *
 * Motion-disabled: render the full text immediately. No reveal.
 */

import * as React from "react"
import { useRef, useState } from "react"
import { Text } from "ink"
import { useFrame, nowMs } from "../use-frame.js"
import { isMotionEnabled } from "../../state/motion.js"

export interface TypewriterProps {
  /** Words per minute. Default 250 — comfortable reading speed. */
  wpm?: number
  /** Optional callback once the full string is revealed. Called once. */
  onDone?: () => void
  /** Color to render the visible portion in. Defaults to inherited. */
  color?: string
  /** Optional bold modifier. */
  bold?: boolean
  children: string
}

/** Average chars per word — tuned for English prose. */
const CHARS_PER_WORD = 5

/** Pause multipliers applied AFTER the corresponding character is revealed. */
const PUNCTUATION_PAUSE: Record<string, number> = {
  ",": 4,
  ";": 4,
  ":": 4,
  "…": 6,
  ".": 8,
  "!": 8,
  "?": 8,
  "\n": 6,
}

/**
 * Pure shape function. Walks the text from the start and accumulates the
 * per-char reveal cost (base interval + punctuation multiplier) until
 * the budget `elapsedMs` is exhausted. Returns the count of fully-
 * revealed characters at this time. Suitable for `text.slice(0, count)`.
 *
 * Doesn't allocate per call — single pass.
 */
export function computeTypewriterCount(text: string, elapsedMs: number, wpm: number): number {
  if (elapsedMs <= 0) return 0
  if (text.length === 0) return 0
  const baseIntervalMs = 60_000 / (wpm * CHARS_PER_WORD)
  let cost = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    const mult = PUNCTUATION_PAUSE[ch] ?? 1
    cost += baseIntervalMs * mult
    if (cost > elapsedMs) return i // i chars are fully revealed; the next isn't yet
  }
  return text.length
}

export function Typewriter({ wpm = 250, onDone, color, bold, children }: TypewriterProps): React.ReactElement {
  const startedAt = useRef<number>(nowMs())
  const fired = useRef<boolean>(false)
  const [count, setCount] = useState<number>(() => isMotionEnabled() ? 0 : children.length)

  // Motion-disabled: fire onDone on next microtask so caller's effect ordering is preserved.
  React.useEffect(() => {
    if (!isMotionEnabled() && onDone && !fired.current) {
      fired.current = true
      queueMicrotask(onDone)
    }
  }, [])

  useFrame((t) => {
    const elapsed = t - startedAt.current
    const next = computeTypewriterCount(children, elapsed, wpm)
    // Stage 1 of 2026-05-18-ui-ux-polish-and-action-aware-spinner plan:
    // skip the setState when the count hasn't advanced. Pre-fix the
    // setState fired every frame even after the reveal completed,
    // accumulating per-frame Ink reconcile work that compounded into a
    // VT100 burst on terminal resize. Now: no advance → no setState.
    if (next !== count) {
      setCount(next)
    }
    if (next >= children.length) {
      if (onDone && !fired.current) {
        fired.current = true
        onDone()
      }
      // Stage 1: detach from the frame loop now that the reveal is
      // complete. The shared scheduler stops automatically when the
      // last subscriber unsubscribes — so a settled Typewriter contributes
      // zero per-frame work.
      return false
    }
  })

  return <Text color={color} bold={bold}>{children.slice(0, count)}</Text>
}
