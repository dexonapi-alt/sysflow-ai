import { describe, it, expect } from "vitest"
import { awarenessGlyph, formatAwarenessTail } from "../Header.js"

describe("awarenessGlyph", () => {
  it("returns ✔ for on_track", () => {
    expect(awarenessGlyph("on_track")).toBe("✔")
  })

  it("returns ⚠ for off_course", () => {
    expect(awarenessGlyph("off_course")).toBe("⚠")
  })

  it("returns ✖ for blocked", () => {
    expect(awarenessGlyph("blocked")).toBe("✖")
  })

  it("returns distinct glyphs for each state — no two collide", () => {
    const glyphs = (["on_track", "off_course", "blocked"] as const).map(awarenessGlyph)
    expect(new Set(glyphs).size).toBe(3)
  })
})

// Stage 4 of plan 2026-05-18-ui-ux-polish-and-action-aware-spinner.md (audit issue #3).
describe("formatAwarenessTail — surfaces lastSignal context when state ≠ on_track", () => {
  it("returns null on on_track (compact badge form)", () => {
    expect(formatAwarenessTail({ state: "on_track", confidence: 92, lastSignal: "anything" })).toBeNull()
  })

  it("returns null when lastSignal is missing on a non-on_track state", () => {
    expect(formatAwarenessTail({ state: "off_course", confidence: 60, lastSignal: null })).toBeNull()
    expect(formatAwarenessTail({ state: "off_course", confidence: 60, lastSignal: "" })).toBeNull()
    expect(formatAwarenessTail({ state: "off_course", confidence: 60, lastSignal: "   " })).toBeNull()
  })

  it("returns the signal verbatim when within the char budget (off_course)", () => {
    expect(formatAwarenessTail({ state: "off_course", confidence: 60, lastSignal: "intent_keyword_absent: postgres" }))
      .toBe("intent_keyword_absent: postgres")
  })

  it("truncates with ellipsis when over the char budget (blocked)", () => {
    const long = "same_action_repeated_in_session: agent ran edit_file on src/db.ts 3x"
    const out = formatAwarenessTail({ state: "blocked", confidence: 25, lastSignal: long })!
    expect(out.length).toBeLessThanOrEqual(40)
    expect(out.endsWith("…")).toBe(true)
  })

  it("trims surrounding whitespace before measuring", () => {
    expect(formatAwarenessTail({ state: "blocked", confidence: 25, lastSignal: "   some signal   " })).toBe("some signal")
  })
})
