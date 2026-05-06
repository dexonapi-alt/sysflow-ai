import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { renderChunkProgress } from "../render.js"

// Strip ANSI escape sequences so assertions don't fight chalk's colour codes.
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "")

describe("renderChunkProgress", () => {
  let spy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    spy = vi.spyOn(console, "log").mockImplementation(() => { /* noop */ })
  })

  afterEach(() => {
    spy.mockRestore()
  })

  function lines(): string[] {
    return spy.mock.calls.flatMap((c) => String(c[0]).split("\n").map(stripAnsi))
  }

  it("emits nothing when both plan and reflection are absent", () => {
    renderChunkProgress({ chunkIndex: 1 })
    expect(spy).not.toHaveBeenCalled()
  })

  it("renders the next action in plain language (no chunk N terminology)", () => {
    renderChunkProgress({
      chunkIndex: 2,
      plan: { nextAction: "write models", files: ["a.js", "b.js", "c.js"] },
    })
    const out = lines().join("\n")
    expect(out).toContain("▸ write models")
    expect(out).toContain("(3 files)")
    // The user should NOT see implementation detail like "chunk N".
    expect(out).not.toMatch(/chunk\s*\d/i)
  })

  it("stays silent on a coherent reflection (no 'last chunk coherent' noise)", () => {
    renderChunkProgress({
      chunkIndex: 3,
      reflection: { coherent: true, issues: [], shouldStop: false },
    })
    expect(spy).not.toHaveBeenCalled()
  })

  it("stays silent on shouldStop with no issues (the completion box is enough)", () => {
    renderChunkProgress({
      chunkIndex: 4,
      reflection: { coherent: true, issues: [], shouldStop: true },
    })
    expect(spy).not.toHaveBeenCalled()
  })

  it("flags issues with natural wording when the reflector says coherent=false", () => {
    renderChunkProgress({
      chunkIndex: 2,
      plan: { nextAction: "wire routes", files: ["src/server.js"] },
      reflection: {
        coherent: false,
        issues: ["server.js imports ./db but no db file was created"],
        shouldStop: false,
      },
    })
    const out = lines().join("\n")
    expect(out).toContain("⚠ 1 thing to fix from last step:")
    expect(out).toContain("server.js imports ./db")
    expect(out).toContain("▸ wire routes")
    expect(out).not.toMatch(/chunk\s*\d/i)
  })

  it("pluralises the issues header correctly", () => {
    renderChunkProgress({
      chunkIndex: 1,
      reflection: {
        coherent: false,
        issues: ["a", "b"],
        shouldStop: false,
      },
    })
    const out = lines().join("\n")
    expect(out).toContain("⚠ 2 things to fix from last step:")
  })

  it("caps the issues list at 3 with a more-indicator", () => {
    renderChunkProgress({
      chunkIndex: 1,
      reflection: {
        coherent: false,
        issues: ["a", "b", "c", "d", "e"],
        shouldStop: false,
      },
    })
    const out = lines().join("\n")
    expect(out).toContain("⚠ 5 things to fix from last step:")
    expect(out).toContain("• a")
    expect(out).toContain("• b")
    expect(out).toContain("• c")
    expect(out).not.toContain("• d")
    expect(out).toContain("…2 more")
  })

  it("uses singular file when files.length === 1", () => {
    renderChunkProgress({
      chunkIndex: 1,
      plan: { nextAction: "write entry", files: ["server.js"] },
    })
    const out = lines().join("\n")
    expect(out).toContain("(1 file)")
    expect(out).not.toContain("(1 files)")
  })

  it("renders issues first then the next action when both are present", () => {
    renderChunkProgress({
      chunkIndex: 3,
      plan: { nextAction: "fix the broken import", files: ["src/server.js"] },
      reflection: {
        coherent: false,
        issues: ["./db doesn't exist"],
        shouldStop: false,
      },
    })
    const all = lines()
    const issuesIdx = all.findIndex((l) => l.includes("to fix from last step"))
    const actionIdx = all.findIndex((l) => l.includes("▸ fix the broken import"))
    expect(issuesIdx).toBeGreaterThanOrEqual(0)
    expect(actionIdx).toBeGreaterThan(issuesIdx)
  })
})
