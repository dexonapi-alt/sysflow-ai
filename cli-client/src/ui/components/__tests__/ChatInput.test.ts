import { describe, it, expect } from "vitest"
import { pickHint, PLACEHOLDER_HINTS } from "../ChatInput.js"

describe("pickHint", () => {
  it("returns the hint at the given index when within bounds", () => {
    expect(pickHint(0)).toBe(PLACEHOLDER_HINTS[0])
    expect(pickHint(1)).toBe(PLACEHOLDER_HINTS[1])
    expect(pickHint(2)).toBe(PLACEHOLDER_HINTS[2])
  })

  it("wraps modulo the list length", () => {
    const len = PLACEHOLDER_HINTS.length
    expect(pickHint(len)).toBe(PLACEHOLDER_HINTS[0])
    expect(pickHint(len + 1)).toBe(PLACEHOLDER_HINTS[1])
    expect(pickHint(len * 7 + 3)).toBe(PLACEHOLDER_HINTS[3])
  })

  it("handles negative indices defensively", () => {
    // |-1| % len = 1, but |-1| floor-abs is 1 → returns hint[1].
    // The contract is "wrap to a valid slot"; exact value matters less than
    // not throwing or returning undefined.
    const got = pickHint(-1)
    expect(PLACEHOLDER_HINTS).toContain(got)
  })

  it("returns the customPlaceholder verbatim when supplied", () => {
    expect(pickHint(5, PLACEHOLDER_HINTS, "ask anything")).toBe("ask anything")
  })

  it("returns empty string when given an empty list and no placeholder", () => {
    expect(pickHint(3, [])).toBe("")
  })

  it("uses a custom list when supplied (independent of PLACEHOLDER_HINTS)", () => {
    const list = ["a", "b", "c"] as const
    expect(pickHint(0, list)).toBe("a")
    expect(pickHint(2, list)).toBe("c")
    expect(pickHint(3, list)).toBe("a") // wraps
  })

  it("PLACEHOLDER_HINTS contains a non-trivial set of hints (at least 3)", () => {
    expect(PLACEHOLDER_HINTS.length).toBeGreaterThanOrEqual(3)
    PLACEHOLDER_HINTS.forEach((h) => expect(typeof h).toBe("string"))
    PLACEHOLDER_HINTS.forEach((h) => expect(h.length).toBeGreaterThan(0))
  })
})
