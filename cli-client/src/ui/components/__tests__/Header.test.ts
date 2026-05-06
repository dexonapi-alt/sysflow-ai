import { describe, it, expect } from "vitest"
import { awarenessGlyph } from "../Header.js"

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
