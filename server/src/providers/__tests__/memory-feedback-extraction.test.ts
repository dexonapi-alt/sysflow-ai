import { describe, it, expect } from "vitest"
import { extractMemoryFeedback } from "../base-provider.js"

describe("extractMemoryFeedback — pure JSON shape extractor", () => {
  it("returns null when the field is absent", () => {
    expect(extractMemoryFeedback({})).toBeNull()
    expect(extractMemoryFeedback({ taskPlan: { title: "x", steps: [] } })).toBeNull()
  })

  it("returns null on non-object inputs (defensive)", () => {
    expect(extractMemoryFeedback(null)).toBeNull()
    expect(extractMemoryFeedback(undefined)).toBeNull()
  })

  it("returns null when memoryFeedback is not an object", () => {
    expect(extractMemoryFeedback({ memoryFeedback: "abc" })).toBeNull()
    expect(extractMemoryFeedback({ memoryFeedback: 42 })).toBeNull()
    expect(extractMemoryFeedback({ memoryFeedback: null })).toBeNull()
    expect(extractMemoryFeedback({ memoryFeedback: [] })).toBeNull()
  })

  it("extracts confirmed-only feedback", () => {
    const r = extractMemoryFeedback({ memoryFeedback: { confirmed: ["abc123", "def456"] } })
    expect(r).toEqual({ confirmed: ["abc123", "def456"], contradicted: [] })
  })

  it("extracts contradicted-only feedback", () => {
    const r = extractMemoryFeedback({ memoryFeedback: { contradicted: ["xyz789"] } })
    expect(r).toEqual({ confirmed: [], contradicted: ["xyz789"] })
  })

  it("extracts mixed feedback in order", () => {
    const r = extractMemoryFeedback({
      memoryFeedback: { confirmed: ["a", "b"], contradicted: ["c"] },
    })
    expect(r).toEqual({ confirmed: ["a", "b"], contradicted: ["c"] })
  })

  it("returns null when both arrays normalise to empty", () => {
    expect(extractMemoryFeedback({ memoryFeedback: { confirmed: [], contradicted: [] } })).toBeNull()
    expect(extractMemoryFeedback({ memoryFeedback: { confirmed: [""], contradicted: [""] } })).toBeNull()
    expect(extractMemoryFeedback({ memoryFeedback: { confirmed: [null, undefined, false] } })).toBeNull()
  })

  it("filters non-string entries from arrays defensively", () => {
    // The function is typed against `Record<string, unknown>`, so this
    // shape passes the type checker and the runtime filter does the work.
    const r = extractMemoryFeedback({
      memoryFeedback: { confirmed: ["valid", 42, null, "another"], contradicted: [false, "x"] },
    })
    expect(r).toEqual({ confirmed: ["valid", "another"], contradicted: ["x"] })
  })

  it("filters empty-string entries (model spit out trailing commas)", () => {
    const r = extractMemoryFeedback({
      memoryFeedback: { confirmed: ["valid", "", "another"], contradicted: [""] },
    })
    expect(r).toEqual({ confirmed: ["valid", "another"], contradicted: [] })
  })

  it("missing arrays default to empty", () => {
    // Only `confirmed` populated; `contradicted` undefined.
    const r = extractMemoryFeedback({ memoryFeedback: { confirmed: ["a"] } })
    expect(r).toEqual({ confirmed: ["a"], contradicted: [] })
  })
})
