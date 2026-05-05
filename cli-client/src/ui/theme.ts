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

// Legacy aliases — kept so files mid-migration can import either name.
export const colors = legacyColors
export const BOX = legacyBox
