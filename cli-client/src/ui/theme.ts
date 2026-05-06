/**
 * Single source of truth for colours, glyphs, and layout constants used by
 * the Ink UI. Re-exports the legacy `cli/render.ts` palette during the
 * migration so existing renderers don't drift; new components should import
 * from this module only.
 */

import { colors as legacyColors, BOX as legacyBox } from "../cli/render.js"

export const palette = {
  accent: "#7C6FFF",
  accentDim: "#5A50B8",
  success: "#58D68D",
  warning: "#F4D03F",
  error: "#E74C3C",
  info: "#5DADE2",
  muted: "#7F8C8D",
  bright: "#ECF0F1",
  tool: "#48C9B0",
  file: "#AEB6BF",
  bar: "#34495E",
} as const

export const glyphs = {
  // Box drawing
  topLeft: "╭", topRight: "╮", botLeft: "╰", botRight: "╯",
  horiz: "─", vert: "│",
  midLeft: "├", midRight: "┤",
  // Status icons
  arrow: "▸", check: "✔", cross: "✖", ring: "○", dot: "●",
  // Spinner — we render our own animation, this is just the dot palette
  spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
} as const

export const layout = {
  /** Outer page indent — same as the legacy console renderer. */
  indent: "  ",
  /** Width Ink should target for boxed regions when the terminal is wider. */
  maxBoxWidth: 80,
} as const

// ─── Phase 12: living-CLI design tokens ──────────────────────────────
//
// One source of truth for the animation language. Components read these
// instead of inlining magic numbers so a future re-skin only touches this
// file. See plan `2026-05-07-phase-12-living-cli-ui.md` for the design
// rationale (single visual metaphor — breath — at three tempos).

/**
 * Heartbeat tempos in beats-per-minute. The animation primitives convert
 * these to period-millis via `60_000 / bpm` (see `easings.ts: breathAt`).
 *
 * - `activeBpm = 60` — the agent is doing visible work. Roughly resting
 *   human heart rate; communicates "alive and present" without urgency.
 * - `idleBpm = 20` — agent is waiting for user input or for I/O. Slow
 *   enough that the motion is barely noticeable but the surface clearly
 *   isn't frozen.
 * - `modalBpm = 40` — modals (permission, off-course) use a slower tempo
 *   than active so the prompt feels composed when the user is asked to
 *   make a decision. Faster than idle so the modal still feels live.
 */
export const tempo = {
  activeBpm: 60,
  idleBpm: 20,
  modalBpm: 40,
} as const

/**
 * Easing curve names. Components import the actual curves from
 * `animation/easings.ts`; this is the semantic dictionary that says
 * which curve a given motion should use. Sticking to these labels
 * prevents the "every component picks its own curve" drift that turns
 * a coherent design language into noise.
 */
export const easing = {
  /** Default for breath / pulse — the base "alive" curve. */
  alive: "breath",
  /** Single-shot success/info events. */
  settle: "cubicOut",
  /** Modal slide-in. Small overshoot reads as composure. */
  land: "elasticOut",
} as const
export type EasingName = (typeof easing)[keyof typeof easing]

/**
 * Gradient endpoints for color-lerp. Each entry is a [from, to] pair of
 * hex strings the lerp walks through. Composite gradients (like the
 * confidence path through yellow) live as helpers in `color-lerp.ts`.
 */
export const gradient = {
  /** Per-stop pairs the confidence helper composes through yellow. */
  confidenceWarm: [palette.success, palette.warning] as const,
  confidenceHot: [palette.warning, palette.error] as const,
  /** Single-flash decay for a tool-error event: warm flare → settled red. */
  errorFlare: [palette.warning, palette.error] as const,
  /** Single-flash decay for a tool-success event: bright accent → muted. */
  successPing: [palette.accent, palette.muted] as const,
} as const

/**
 * Layout spacing — extends `layout` with intra-component pads so cards
 * and modals share consistent rhythm. All values are character widths.
 */
export const spacing = {
  /** Padding inside a tool card or modal box. */
  cardInner: 1,
  /** Vertical gap between consecutive cards in the stream. */
  cardGap: 1,
  /** Padding inside a modal between border and contents. */
  modalInner: 2,
  /** Indent for sub-bullets (signal lists, evidence rows). */
  subIndent: 4,
} as const

/**
 * Phase 11 awareness state → palette colour. Semantic accessor so
 * components don't reach for `palette.success` directly when they
 * mean "on_track confidence" — keeps the colour grammar consistent
 * if the awareness colour map ever needs to change.
 *
 * The dynamic confidence-gradient (smooth lerp by score 0-100) lives
 * in `color-lerp.ts: confidenceGradient()`. This accessor returns the
 * discrete state colour, used by the static (non-animated) badge
 * fallback in `--no-motion` mode.
 */
export const awarenessState = {
  on_track: palette.success,
  off_course: palette.warning,
  blocked: palette.error,
} as const
export type AwarenessStateKey = keyof typeof awarenessState

export function awarenessColor(state: AwarenessStateKey): string {
  return awarenessState[state]
}

// Legacy aliases — kept so files mid-migration can import either name.
export const colors = legacyColors
export const BOX = legacyBox
