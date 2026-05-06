import { describe, it, expect } from "vitest"
import { variantForCardStatus } from "../ToolCard.js"
import { palette } from "../../theme.js"

describe("variantForCardStatus", () => {
  it("running uses the accent color and arrow glyph", () => {
    const v = variantForCardStatus("running")
    expect(v.borderColor).toBe(palette.accent)
    expect(v.glyph).toBe("▸")
    expect(v.glyphColor).toBe(palette.accent)
  })

  it("success uses muted border + green check glyph", () => {
    const v = variantForCardStatus("success")
    expect(v.borderColor).toBe(palette.muted)
    expect(v.glyph).toBe("✔")
    expect(v.glyphColor).toBe(palette.success)
  })

  it("error uses error border + cross glyph in error color", () => {
    const v = variantForCardStatus("error")
    expect(v.borderColor).toBe(palette.error)
    expect(v.glyph).toBe("✖")
    expect(v.glyphColor).toBe(palette.error)
  })

  it("returns distinct visuals for each status (no two states accidentally collide)", () => {
    const variants = (["running", "success", "error"] as const).map(variantForCardStatus)
    const fingerprints = variants.map((v) => `${v.borderColor}|${v.glyph}|${v.glyphColor}`)
    expect(new Set(fingerprints).size).toBe(3)
  })
})
