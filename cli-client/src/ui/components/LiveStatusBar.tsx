/**
 * <LiveStatusBar> — bottom-row heartbeat for the Phase 12 living-CLI.
 *
 * Always visible at the bottom of the App. Three live cells in v1
 * (Stage 3), more land as later stages plumb their event payloads:
 *
 *   ◦  ready · 0:23
 *   ●  thinking · 0:42 · ⟶ chunk 3      (Stages 4-5 add the trailing cells)
 *
 * Cell behaviour:
 *   - **Glyph** — `<Breath>` between accentDim and accent. Tempo
 *     follows agent state: `activeBpm` while a spinner event is in
 *     flight, `idleBpm` between runs. The glyph is the same character
 *     either way — the user reads "alive" from the speed of the pulse,
 *     not from a glyph swap.
 *   - **Status** — `ready` while idle, `working` while a run is in
 *     flight (the spinner above carries the verb-of-the-moment, so we
 *     don't repeat it here — keeps the eye from being pulled back and
 *     forth between two spots that say the same thing).
 *   - **Elapsed time** — auto-ticks via `useFrame`. Restarts at 0
 *     each time work begins (spinner null → set); freezes when work
 *     ends until the next run.
 *
 * Motion-disabled: breath collapses to a static dot, elapsed time
 * still advances (one tick per useFrame cycle, which itself fires
 * once-and-stops in motion-disabled mode → the time value here will
 * be "frozen at the moment of last paint" rather than continuously
 * ticking, which is the right tradeoff for `--no-motion`).
 */

import * as React from "react"
import { useEffect, useState } from "react"
import { Box, Text } from "ink"
import { palette, tempo } from "../theme.js"
import { Breath } from "../animation/primitives/index.js"
import { useFrame, nowMs } from "../animation/use-frame.js"
import { useAgentEvents } from "../hooks/useAgentEvents.js"

/**
 * Format an elapsed millisecond count as `M:SS` or `H:MM:SS`. Pure;
 * exported for tests so the format contract isn't asserted via render.
 */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0:00"
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h}:${pad2(m)}:${pad2(s)}`
  return `${m}:${pad2(s)}`
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

export function LiveStatusBar(): React.ReactElement {
  const { spinnerText } = useAgentEvents()
  const isWorking = spinnerText !== null

  // Per-run elapsed clock. `runStartedAt` resets to "now" each time the
  // spinner transitions from idle → active. Between runs the clock is
  // frozen on the last value rather than continuing to count.
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null)
  const [frozenElapsed, setFrozenElapsed] = useState<number>(0)
  const [now, setNow] = useState<number>(() => nowMs())

  useEffect(() => {
    if (isWorking && runStartedAt === null) {
      setRunStartedAt(nowMs())
    } else if (!isWorking && runStartedAt !== null) {
      // Capture the final elapsed so the clock visibly stops where it ended.
      setFrozenElapsed(nowMs() - runStartedAt)
      setRunStartedAt(null)
    }
  }, [isWorking])

  useFrame((t) => setNow(t))

  const elapsedMs = runStartedAt !== null ? now - runStartedAt : frozenElapsed
  const elapsed = formatElapsed(elapsedMs)
  const breathBpm = isWorking ? tempo.activeBpm : tempo.idleBpm

  // Status word — kept to a single token so the eye scans it as one
  // unit rather than reading-it-as-text. "ready" / "working" carry
  // enough state without overlapping the spinner above.
  const statusWord = isWorking ? "working" : "ready"
  const statusColor = isWorking ? palette.accent : palette.muted

  return (
    <Box>
      <Text>  </Text>
      <Breath from={palette.accentDim} to={palette.accent} bpm={breathBpm}>◦</Breath>
      <Text color={palette.muted}>  </Text>
      <Text color={statusColor}>{statusWord}</Text>
      <Text color={palette.muted}>  ·  {elapsed}</Text>
    </Box>
  )
}
