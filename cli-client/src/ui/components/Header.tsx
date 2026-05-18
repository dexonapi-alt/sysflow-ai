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
 * Stage 5 of plan 2026-05-18-ui-ux-polish-and-action-aware-spinner.md
 * (audit issue #8): pure helper that picks the chunk-cell render
 * mode based on (a) whether a chunk_plan has fired and (b) the run's
 * classified intent.
 *
 * Three exhaustive modes:
 *
 *   "implement-pulse"     — runIntent === "implement" (with chunk present)
 *                           OR pre-classification window (chunk present,
 *                           runIntent still null — legacy / pre-Phase-19
 *                           path). Renders the colored <Pulse>.
 *   "internal-indicator"  — chunk present, runIntent classified to a
 *                           non-implement value (simple Q&A, summary, bug).
 *                           Renders the muted "· thinking through it" cell
 *                           so the user still sees activity without the
 *                           multi-step-plan cue.
 *   "hidden"              — no chunk_plan has fired yet. Nothing to render.
 *
 * Pre-Stage-5 these three modes were tangled across three conditional
 * branches in the JSX with overlapping conditions. The helper makes the
 * decision exhaustive + testable; the JSX collapses to one switch.
 *
 * Exported for direct tests.
 */
export type ChunkRenderMode = "implement-pulse" | "internal-indicator" | "hidden"

export function chunkRenderMode(
  chunkPresent: boolean,
  runIntent: "simple" | "summary" | "bug" | "implement" | null,
): ChunkRenderMode {
  if (!chunkPresent) return "hidden"
  if (runIntent === "implement" || runIntent === null) return "implement-pulse"
  return "internal-indicator"
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
  const { awareness, chunk, runIntent } = useAgentEvents()

  // Stage 5 of plan 2026-05-18-ui-ux-polish-and-action-aware-spinner.md
  // (audit issue #8): single exhaustive helper replaces the three
  // overlapping JSX branches that used to live here.
  const chunkMode = chunkRenderMode(chunk !== null, runIntent)

  // Plan 2026-05-18-chunk-pulse-missing-diagnostic.md Stage 1 — log
  // the reducer's chunk slot + chunkMode whenever they change.
  // Confirms hypothesis (b) "emit fires but reducer doesn't store"
  // vs (c) "chunk stored but Header renders hidden". Debounced via
  // useEffect dependency so we don't log on every pulse tick.
  // STAGE 3 WILL REMOVE THIS.
  const lastLoggedRef = React.useRef<string>("")
  React.useEffect(() => {
    const sig = `chunk=${chunk?.index ?? null} runIntent=${runIntent} mode=${chunkMode}`
    if (sig !== lastLoggedRef.current) {
      lastLoggedRef.current = sig
      console.log(`[chunk-pulse-diag] header-render: ${sig}`)
    }
  }, [chunk?.index, runIntent, chunkMode])

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
        {chunkMode === "implement-pulse" && chunk && (
          <>
            <Text color={palette.muted}>  ·  </Text>
            <Pulse flash={palette.accent} settle={palette.muted} triggerKey={chunk.pulseKey}>
              {`▸ ${chunk.index}`}
            </Pulse>
          </>
        )}
        {chunkMode === "internal-indicator" && (
          <>
            <Text color={palette.muted}>  ·  </Text>
            <Text color={palette.muted}>{`· thinking through it`}</Text>
          </>
        )}
      </Box>
      {/*
       * Phase 14 Stage 5: the second row of slash-command names that
       * used to live here was duplicated by the new <InteractiveHints>
       * row at the bottom of the App and the slash autocomplete popup
       * inside ChatInput. Removing it tightens the top zone to the
       * single identity row + live cells.
       */}
    </Box>
  )
}

/**
 * Stage 4 of plan 2026-05-18-ui-ux-polish-and-action-aware-spinner.md
 * (audit issue #3): max chars for the lastSignal tail rendered next
 * to the awareness badge when state ≠ on_track. Bounded so the badge
 * doesn't push other Header cells off the terminal on narrow widths.
 */
const LAST_SIGNAL_MAX_CHARS = 40

/**
 * Pure: format the lastSignal tail for display alongside the awareness
 * badge. Returns null when the snapshot is on_track OR has no signal —
 * those cases render the compact `glyph score` form.
 *
 * The signal text from the reducer often has the shape
 * `"<category>: <detail>"`, but the divergence detector emits a
 * description-only string. We surface whatever's there (truncated to
 * LAST_SIGNAL_MAX_CHARS) so the user sees WHY the badge is yellow/red.
 *
 * Exported for direct tests.
 */
export function formatAwarenessTail(snapshot: AwarenessSnapshot): string | null {
  if (snapshot.state === "on_track") return null
  if (!snapshot.lastSignal || snapshot.lastSignal.trim().length === 0) return null
  const sig = snapshot.lastSignal.trim()
  if (sig.length <= LAST_SIGNAL_MAX_CHARS) return sig
  return sig.slice(0, Math.max(0, LAST_SIGNAL_MAX_CHARS - 1)) + "…"
}

/**
 * The awareness cell. Glyph + score, with the score colour interpolated
 * through the confidence gradient so the user reads state from colour
 * before they read the number. Glyph carries the state for `--no-motion`
 * mode (where the colour interpolation collapses to a single stop).
 *
 * Stage 4 (audit issue #3): when state ≠ on_track, append the latest
 * divergence signal (truncated) so the user knows WHY confidence
 * dropped. On-track stays compact (`✔ 92`).
 */
function AwarenessBadge({ snapshot }: { snapshot: AwarenessSnapshot }): React.ReactElement {
  const glyph = awarenessGlyph(snapshot.state)
  const t = confidenceToGradientT(snapshot.confidence)
  const colour = confidenceGradient(t)
  const score = Math.round(snapshot.confidence)
  const tail = formatAwarenessTail(snapshot)
  return (
    <>
      <Text color={colour}>{glyph}</Text>
      <Text color={colour}> {score}</Text>
      {tail && (
        <>
          <Text color={palette.muted}>{" ("}</Text>
          <Text color={palette.muted}>{tail}</Text>
          <Text color={palette.muted}>{")"}</Text>
        </>
      )}
    </>
  )
}
