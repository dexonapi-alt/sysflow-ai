import { describe, it, expect } from "vitest"
import { hashContext } from "../task-reasoner.js"

describe("hashContext (Phase 10 cache-key safety)", () => {
  it("produces a stable hex string for the same input", () => {
    const ctx = { chunkHistory: [{ index: 0, plan: { files: ["a.js"] } }] }
    expect(hashContext(ctx)).toBe(hashContext(ctx))
    expect(hashContext(ctx)).toMatch(/^[0-9a-f]{64}$/)
  })

  it("returns distinct hashes for distinct contexts that share a 2 KB prefix", () => {
    // Build a long history where the only difference is at position >2000.
    // The OLD slice(0, 2000) cache key would have collided here; sha256
    // over the full string distinguishes them.
    const long = "x".repeat(2050)
    const a = { history: long + "ENDA" }
    const b = { history: long + "ENDB" }
    expect(hashContext(a)).not.toBe(hashContext(b))
  })

  it("treats an empty / undefined context as a stable empty hash", () => {
    expect(hashContext(undefined)).toBe(hashContext(undefined))
    expect(hashContext({})).toBe(hashContext({}))
  })

  it("is order-sensitive — changing array order yields a different hash", () => {
    const a = { files: ["a.js", "b.js"] }
    const b = { files: ["b.js", "a.js"] }
    expect(hashContext(a)).not.toBe(hashContext(b))
  })
})
