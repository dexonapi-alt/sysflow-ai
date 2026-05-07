import { describe, it, expect } from "vitest"
import { deriveHintState } from "../InteractiveHints.js"

describe("deriveHintState", () => {
  it("returns 'idle' when spinnerText is null", () => {
    expect(deriveHintState(null)).toBe("idle")
  })

  it("returns 'working' when spinnerText is a non-empty string", () => {
    expect(deriveHintState("thinking…")).toBe("working")
  })

  it("returns 'working' even for an empty-string spinnerText (the bus uses empty-string for the un-textured spinner)", () => {
    // The reducer normalises a `{type: "spinner"}` event with no text to
    // `spinnerText: ""` (truthy presence, no label) — that should still
    // count as working.
    expect(deriveHintState("")).toBe("working")
  })

  it("never throws on the union it is contracted to handle (idle / working only)", () => {
    expect(() => deriveHintState(null)).not.toThrow()
    expect(() => deriveHintState("x")).not.toThrow()
  })
})
