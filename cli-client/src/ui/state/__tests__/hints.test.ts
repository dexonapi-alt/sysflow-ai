import { describe, it, expect } from "vitest"
import { pickHints, formatHints, HINT_TABLE } from "../hints.js"

describe("pickHints", () => {
  it("returns the idle hint set when state is idle", () => {
    expect(pickHints("idle")).toEqual(HINT_TABLE.idle)
  })

  it("returns the working hint set when state is working", () => {
    expect(pickHints("working")).toEqual(HINT_TABLE.working)
  })

  it("falls back to idle for an unknown state (defensive)", () => {
    expect(pickHints("totally_made_up_state")).toEqual(HINT_TABLE.idle)
  })

  it("each declared state's hints contain at least one entry", () => {
    for (const state of Object.keys(HINT_TABLE) as Array<keyof typeof HINT_TABLE>) {
      expect(HINT_TABLE[state].length).toBeGreaterThanOrEqual(1)
    }
  })

  it("idle hints surface ↑ history + tab complete + ctrl+c exit (the always-true affordances)", () => {
    const hints = pickHints("idle")
    expect(hints.some((h) => h.includes("history"))).toBe(true)
    expect(hints.some((h) => h.includes("tab"))).toBe(true)
    expect(hints.some((h) => h.includes("ctrl+c"))).toBe(true)
  })

  it("working hints surface ctrl+c cancel (the only safe affordance mid-run)", () => {
    const hints = pickHints("working")
    expect(hints.some((h) => h.includes("ctrl+c"))).toBe(true)
    expect(hints.some((h) => h.includes("cancel"))).toBe(true)
  })
})

describe("formatHints", () => {
  it("joins entries with the muted-dot separator", () => {
    expect(formatHints(["a", "b", "c"])).toBe("a  ·  b  ·  c")
  })

  it("returns an empty string for an empty list", () => {
    expect(formatHints([])).toBe("")
  })

  it("returns the single entry verbatim when only one hint is present", () => {
    expect(formatHints(["ctrl+c cancel"])).toBe("ctrl+c cancel")
  })

  it("preserves the order of entries (no sort, no shuffle)", () => {
    expect(formatHints(["z", "a", "m"])).toBe("z  ·  a  ·  m")
  })
})
