/**
 * <Header> — Phase 12 Stage 5: persistent top zone for the living CLI.
 *
 * Always visible at the top of App.tsx. Single row composed of static
 * identity cells (model, folder, chat, user) plus two live cells that
 * appear when the agent emits matching events:
 *
 *   sys · folder · model · chat:title · user                  (idle)
 *   sys · folder · model · chat:title · user · ✔ 92 · ▸ 3      (active)
 *
 * Live cells:
 *   - Awareness badge (`✔ 92`): glyph + score. Glyph reflects the
 *     coarse state via `awarenessGlyph()`; the score's COLOUR is
 *     interpolated through Stage 1's `confidenceGradient` so a
 *     drop from 100 → 30 reads as a smooth shift through yellow,
 *     not three discrete swap. With `--no-motion` the colour is
 *     the lerped baseline (no breath); the glyph is what tells the
 *     user the state.
 *   - Chunk pulse (`▸ 3`): renders only after the first chunk_plan
 *     event arrives. The dot uses `<Pulse>` keyed on `pulseKey`
 *     so a new chunk re-fires the ping; the index reads as a
 *     monotonic counter.
 *
 * The header is sticky — App.tsx mounts it once at the top and the
 * AgentStream below scrolls past it. No re-render cost beyond the
 * Pulse / colour-lerp ticks (settled awareness colours stop ticking).
 */

import * as React from "react"
import path from "node:path"
import { Box, Text } from "ink"
import { palette } from "../theme.js"
import { Pulse } from "../animation/primitives/index.js"
import { confidenceGradient } from "../animation/color-lerp.js"
import { useAgentEvents, type AwarenessSnapshot } from "../hooks/useAgentEvents.js"

interface Props {
  model: string
  user: string | null
  chatTitle: string | null
  planMode: boolean
  cwd?: string
}

/**
 * Map an awareness state to its glyph. Pure helper — exported so the
 * `--no-motion` fallback in tests asserts the same mapping the renderer
 * uses, and so a future status-line variant can re-use it.
 */
export function awarenessGlyph(state: AwarenessSnapshot["state"]): string {
  switch (state) {
    case "on_track":  return "✔"
    case "off_course": return "⚠"
    case "blocked":   return "✖"
  }
}

/**
 * Map a confidence score (0–100) to the position along the green→red
 * gradient (0–1). Slightly exponential so high-confidence scores cluster
 * at the green end — a 90 should still feel solidly green, not "near
 * yellow" which a linear mapping would imply.
 */
function confidenceToGradientT(confidence: number): number {
  if (!Number.isFinite(confidence)) return 0
  if (confidence >= 100) return 0
  if (confidence <= 0) return 1
  return Math.pow((100 - confidence) / 100, 0.85)
}

export function Header({ model, user, chatTitle, planMode, cwd }: Props): React.ReactElement {
  const folder = path.basename(cwd ?? process.cwd())
  const { awareness, chunk } = useAgentEvents()

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={palette.muted}>  sys v0.1  </Text>
        <Text>{folder}</Text>
        <Text color={palette.muted}>  ·  </Text>
        <Text>{model}</Text>
        <Text color={palette.muted}>  ·  </Text>
        <Text color={chatTitle ? palette.info : palette.muted}>{chatTitle ?? "no chat"}</Text>
        <Text color={palette.muted}>  ·  </Text>
        <Text color={user ? palette.success : palette.warning}>{user ?? "not logged in"}</Text>
        {planMode && (
          <>
            <Text color={palette.muted}>  ·  </Text>
            <Text color={palette.warning}>plan-mode</Text>
          </>
        )}
        {awareness && (
          <>
            <Text color={palette.muted}>  ·  </Text>
            <AwarenessBadge snapshot={awareness} />
          </>
        )}
        {chunk && (
          <>
            <Text color={palette.muted}>  ·  </Text>
            <Pulse flash={palette.accent} settle={palette.muted} triggerKey={chunk.pulseKey}>
              {`▸ ${chunk.index}`}
            </Pulse>
          </>
        )}
      </Box>
      <Box>
        <Text color={palette.muted}>  /model /mode /permissions /plan-mode /memory /remember /chats /billing /usage /login /whoami /continue /exit</Text>
      </Box>
    </Box>
  )
}

/**
 * The awareness cell. Glyph + score, with the score colour interpolated
 * through the confidence gradient so the user reads state from colour
 * before they read the number. Glyph carries the state for `--no-motion`
 * mode (where the colour interpolation collapses to a single stop).
 */
function AwarenessBadge({ snapshot }: { snapshot: AwarenessSnapshot }): React.ReactElement {
  const glyph = awarenessGlyph(snapshot.state)
  const t = confidenceToGradientT(snapshot.confidence)
  const colour = confidenceGradient(t)
  const score = Math.round(snapshot.confidence)
  return (
    <>
      <Text color={colour}>{glyph}</Text>
      <Text color={colour}> {score}</Text>
    </>
  )
}
