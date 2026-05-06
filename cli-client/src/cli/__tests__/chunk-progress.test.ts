import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { renderChunkProgress, renderConfidenceBadge } from "../render.js"

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

  // ─── Phase 11 Stage 5: confidence badge integration ───

  it("hides the badge when awareness state is on_track (happy path stays clean)", () => {
    renderChunkProgress({
      chunkIndex: 1,
      plan: { nextAction: "write models", files: ["a.js"] },
      awareness: { state: "on_track", confidence: 100, lastSignal: null },
    })
    const out = lines().join("\n")
    expect(out).toContain("▸ write models")
    // No ⚠ / ✖ glyph should leak when we're fine.
    expect(out).not.toMatch(/[⚠✖]/)
  })

  it("renders the yellow badge inline when state is off_course", () => {
    renderChunkProgress({
      chunkIndex: 2,
      plan: { nextAction: "wire routes", files: ["src/server.js"] },
      awareness: { state: "off_course", confidence: 55, lastSignal: "tool error \"edit_file\" repeated 3 times" },
    })
    const all = lines()
    const actionLine = all.find((l) => l.includes("▸ wire routes"))!
    expect(actionLine).toContain("⚠")
    expect(actionLine).toContain("55")
    // The off_course state surfaces the most recent signal underneath.
    expect(all.some((l) => l.includes("tool error"))).toBe(true)
  })

  it("renders the red badge inline when state is blocked", () => {
    renderChunkProgress({
      chunkIndex: 3,
      plan: { nextAction: "stop", files: ["x.js"] },
      awareness: { state: "blocked", confidence: 18, lastSignal: null },
    })
    const actionLine = lines().find((l) => l.includes("▸ stop"))!
    expect(actionLine).toContain("✖")
    expect(actionLine).toContain("18")
  })
})

describe("renderConfidenceBadge", () => {
  it("renders ✓ for on_track", () => {
    expect(stripAnsi(renderConfidenceBadge("on_track", 95))).toContain("✔")
    expect(stripAnsi(renderConfidenceBadge("on_track", 95))).toContain("95")
  })

  it("renders ⚠ for off_course", () => {
    expect(stripAnsi(renderConfidenceBadge("off_course", 55))).toContain("⚠")
    expect(stripAnsi(renderConfidenceBadge("off_course", 55))).toContain("55")
  })

  it("renders ✖ for blocked", () => {
    expect(stripAnsi(renderConfidenceBadge("blocked", 20))).toContain("✖")
    expect(stripAnsi(renderConfidenceBadge("blocked", 20))).toContain("20")
  })

  it("omits the score when not provided", () => {
    expect(stripAnsi(renderConfidenceBadge("on_track"))).toBe("✔")
  })

  it("rounds the score to an integer", () => {
    expect(stripAnsi(renderConfidenceBadge("off_course", 73.4))).toContain("73")
  })
})
