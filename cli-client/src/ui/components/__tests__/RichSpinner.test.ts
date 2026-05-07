import { describe, it, expect } from "vitest"
import { pickPrimaryGlyph, formatTokens, SPINNER_GLYPHS, SPINNER_COLORS } from "../RichSpinner.js"

describe("pickPrimaryGlyph", () => {
  // 60 bpm = 1000ms period, 4 glyphs → 250ms per slot.
  const BPM = 60
  const PERIOD = 60_000 / BPM // 1000

  it("starts at index 0 at the cycle origin", () => {
    expect(pickPrimaryGlyph(0, BPM, 4)).toBe(0)
  })

  it("advances through every slot across one period", () => {
    expect(pickPrimaryGlyph(PERIOD * 0.0, BPM, 4)).toBe(0)
    expect(pickPrimaryGlyph(PERIOD * 0.25, BPM, 4)).toBe(1)
    expect(pickPrimaryGlyph(PERIOD * 0.5, BPM, 4)).toBe(2)
    expect(pickPrimaryGlyph(PERIOD * 0.75, BPM, 4)).toBe(3)
  })

  it("wraps modulo glyph count across multiple periods", () => {
    // Same fraction of the cycle should pick the same slot regardless of period.
    expect(pickPrimaryGlyph(PERIOD * 1.25, BPM, 4)).toBe(1)
    expect(pickPrimaryGlyph(PERIOD * 7.5, BPM, 4)).toBe(2)
  })

  it("scales with bpm — 120bpm = 500ms period, slot at t=125ms is index 1", () => {
    expect(pickPrimaryGlyph(125, 120, 4)).toBe(1)
  })

  it("returns 0 defensively for non-positive bpm or empty glyph set", () => {
    expect(pickPrimaryGlyph(500, 0, 4)).toBe(0)
    expect(pickPrimaryGlyph(500, -10, 4)).toBe(0)
    expect(pickPrimaryGlyph(500, 60, 0)).toBe(0)
    expect(pickPrimaryGlyph(500, 60, -1)).toBe(0)
  })

  it("never returns an out-of-bounds index", () => {
    for (let t = 0; t <= 5_000; t += 17) {
      const idx = pickPrimaryGlyph(t, BPM, SPINNER_GLYPHS.length)
      expect(idx).toBeGreaterThanOrEqual(0)
      expect(idx).toBeLessThan(SPINNER_GLYPHS.length)
    }
  })

  it("SPINNER_GLYPHS has exactly 4 distinct characters", () => {
    expect(SPINNER_GLYPHS.length).toBe(4)
    expect(new Set(SPINNER_GLYPHS).size).toBe(4)
  })
})

describe("SPINNER_COLORS — single-glyph colour rotation", () => {
  it("has the same length as SPINNER_GLYPHS so every glyph is paired with a colour", () => {
    expect(SPINNER_COLORS.length).toBe(SPINNER_GLYPHS.length)
  })

  it("uses 4 distinct hex strings (the rotation is visible because each frame is a different colour)", () => {
    expect(new Set(SPINNER_COLORS).size).toBe(SPINNER_COLORS.length)
  })

  it("every entry is a hex colour string the way Ink expects", () => {
    for (const c of SPINNER_COLORS) {
      expect(typeof c).toBe("string")
      expect(c).toMatch(/^#[0-9A-Fa-f]{6}$/)
    }
  })
})

describe("formatTokens", () => {
  it("renders small counts as plain integers", () => {
    expect(formatTokens(0)).toBe("0")
    expect(formatTokens(1)).toBe("1")
    expect(formatTokens(42)).toBe("42")
    expect(formatTokens(999)).toBe("999")
  })

  it("rounds non-integer small counts", () => {
    expect(formatTokens(99.4)).toBe("99")
    expect(formatTokens(99.6)).toBe("100")
  })

  it("renders thousands as Xk with one decimal place, trimming .0", () => {
    expect(formatTokens(1_000)).toBe("1k")
    expect(formatTokens(1_500)).toBe("1.5k")
    expect(formatTokens(12_300)).toBe("12.3k")
    expect(formatTokens(99_900)).toBe("99.9k")
  })

  it("renders millions as XM with one decimal place, trimming .0", () => {
    expect(formatTokens(1_000_000)).toBe("1M")
    expect(formatTokens(1_234_567)).toBe("1.2M")
    expect(formatTokens(15_000_000)).toBe("15M")
  })

  it("preserves sign for negative deltas (overlay can show ↓ tokens too)", () => {
    expect(formatTokens(-500)).toBe("-500")
    expect(formatTokens(-12_300)).toBe("-12.3k")
  })

  it("handles non-finite input defensively", () => {
    expect(formatTokens(NaN)).toBe("0")
    expect(formatTokens(Infinity)).toBe("0")
    expect(formatTokens(-Infinity)).toBe("0")
  })
})
