/**
 * Color interpolation in HSL space for the Phase 12 living-CLI palette.
 *
 * RGB-space lerp can pass through unintended hues — e.g. interpolating
 * #58D68D (green) → #E74C3C (red) in RGB drops through a muddy brown at
 * the midpoint. HSL lerp follows the colour wheel and stays vivid the
 * whole way. The badge colour-shift on confidence drop uses this.
 *
 * Two render modes, picked once per process by reading `chalk.level`:
 *   - **Truecolor (level >= 3):** the lerped hex string via `chalk.hex()`.
 *   - **256-color (level <= 2):** quantise the lerped colour to the nearest
 *     of N discrete stops between the two endpoints (N = `discreteStops`,
 *     default 4) and render via the closest hex chalk supports. The result
 *     is steppier but doesn't band into 16-color soup.
 *
 * The fallback is intentionally crude — a future iteration could ship a
 * colour-cube lookup, but most users on truecolor terminals never touch it.
 */

import chalk from "chalk"

export interface ColorLerpOptions {
  /** Number of discrete stops between endpoints in the 256-color fallback. */
  discreteStops?: number
}

/**
 * Compute the lerped hex colour for `t ∈ [0, 1]` between `from` and `to`,
 * walking through HSL space. Returns a `#rrggbb` string. Pure — does no
 * rendering. Use `paint()` for the chalk-aware version.
 */
export function lerpHex(from: string, to: string, t: number, opts: ColorLerpOptions = {}): string {
  const tt = clamp01(t)
  const a = hexToHsl(from)
  const b = hexToHsl(to)
  const h = lerpHue(a.h, b.h, tt)
  const s = a.s + (b.s - a.s) * tt
  const l = a.l + (b.l - a.l) * tt
  const final = hslToHex(h, s, l)
  if (chalk.level >= 3) return final

  // 256-color fallback: snap to one of the discrete stops.
  const stops = Math.max(2, opts.discreteStops ?? 4)
  const snapped = Math.round(tt * (stops - 1)) / (stops - 1)
  const sh = lerpHue(a.h, b.h, snapped)
  const ss = a.s + (b.s - a.s) * snapped
  const sl = a.l + (b.l - a.l) * snapped
  return hslToHex(sh, ss, sl)
}

/**
 * Wrap text in the lerped colour. Convenience wrapper that handles
 * the chalk-level / truecolor decision so callers don't import `chalk`
 * directly for animated text.
 *
 * Returns the input string unchanged when chalk is at level 0 (no colour
 * support at all — e.g. piped to a file).
 */
export function paint(text: string, from: string, to: string, t: number, opts: ColorLerpOptions = {}): string {
  if (chalk.level === 0) return text
  return chalk.hex(lerpHex(from, to, t, opts))(text)
}

/**
 * Pick the colour for a confidence state along the green → yellow → red
 * gradient. `t ∈ [0, 1]` where 0 = on_track (green), 0.5 = off_course
 * (yellow), 1 = blocked (red). Used by the Phase 11 awareness badge to
 * shift smoothly between states instead of swapping glyphs cold.
 */
export function confidenceGradient(t: number, opts: ColorLerpOptions = {}): string {
  const tt = clamp01(t)
  // Two-stop gradient through yellow at the midpoint so the path is
  // green → yellow → red along the warm side of HSL, not via cyan.
  if (tt <= 0.5) {
    return lerpHex("#58D68D", "#F4D03F", tt * 2, opts)
  }
  return lerpHex("#F4D03F", "#E74C3C", (tt - 0.5) * 2, opts)
}

// ─── HSL <-> hex helpers ──────────────────────────────────────────────

interface Hsl { h: number; s: number; l: number }

function hexToHsl(hex: string): Hsl {
  const h = hex.replace("#", "")
  const r = parseInt(h.slice(0, 2), 16) / 255
  const g = parseInt(h.slice(2, 4), 16) / 255
  const b = parseInt(h.slice(4, 6), 16) / 255

  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2

  if (max === min) return { h: 0, s: 0, l }

  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)

  let hue = 0
  switch (max) {
    case r: hue = ((g - b) / d + (g < b ? 6 : 0)); break
    case g: hue = ((b - r) / d + 2); break
    case b: hue = ((r - g) / d + 4); break
  }
  return { h: hue * 60, s, l }
}

function hslToHex(h: number, s: number, l: number): string {
  const hh = ((h % 360) + 360) % 360 / 360
  let r: number, g: number, b: number
  if (s === 0) {
    r = g = b = l
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s
    const p = 2 * l - q
    r = hueToRgb(p, q, hh + 1 / 3)
    g = hueToRgb(p, q, hh)
    b = hueToRgb(p, q, hh - 1 / 3)
  }
  return "#" + toHex(r) + toHex(g) + toHex(b)
}

function hueToRgb(p: number, q: number, t: number): number {
  let tt = t
  if (tt < 0) tt += 1
  if (tt > 1) tt -= 1
  if (tt < 1 / 6) return p + (q - p) * 6 * tt
  if (tt < 1 / 2) return q
  if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6
  return p
}

function toHex(v: number): string {
  const i = Math.round(clamp01(v) * 255)
  return i.toString(16).padStart(2, "0")
}

/**
 * Interpolate hue along the SHORT arc of the colour wheel. Without this,
 * a green → red lerp could go the long way through cyan-blue-magenta.
 */
function lerpHue(a: number, b: number, t: number): number {
  const diff = ((b - a + 540) % 360) - 180
  return (a + diff * t + 360) % 360
}

function clamp01(t: number): number {
  if (t < 0) return 0
  if (t > 1) return 1
  return t
}
