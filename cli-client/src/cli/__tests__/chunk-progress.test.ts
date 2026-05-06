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

  it("renders chunk index + planner action + file count", () => {
    renderChunkProgress({
      chunkIndex: 2,
      plan: { nextAction: "write models", files: ["a.js", "b.js", "c.js"] },
    })
    const out = lines().join("\n")
    expect(out).toContain("chunk 2")
    expect(out).toContain("write models")
    expect(out).toContain("(3 files)")
  })

  it("flags the final chunk", () => {
    renderChunkProgress({
      chunkIndex: 5,
      plan: { nextAction: "polish", files: ["README.md"], isFinalChunk: true },
    })
    const out = lines().join("\n")
    expect(out).toContain("· final")
  })

  it("renders coherent reflection with check mark", () => {
    renderChunkProgress({
      chunkIndex: 3,
      reflection: { coherent: true, issues: [], shouldStop: false },
    })
    const out = lines().join("\n")
    expect(out).toContain("✔ last chunk coherent")
  })

  it("renders shouldStop reflection separately", () => {
    renderChunkProgress({
      chunkIndex: 4,
      reflection: { coherent: true, issues: [], shouldStop: true },
    })
    const out = lines().join("\n")
    expect(out).toContain("wrapping up")
  })

  it("flags incoherent reflection with warning + lists issues", () => {
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
    expect(out).toContain("⚠ 1 issue from last chunk")
    expect(out).toContain("server.js imports ./db")
  })

  it("caps issues list at 3 with a more-indicator", () => {
    renderChunkProgress({
      chunkIndex: 1,
      reflection: {
        coherent: false,
        issues: ["a", "b", "c", "d", "e"],
        shouldStop: false,
      },
    })
    const out = lines().join("\n")
    expect(out).toContain("⚠ 5 issues from last chunk")
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

  it("renders both plan + reflection on the same line", () => {
    renderChunkProgress({
      chunkIndex: 3,
      plan: { nextAction: "wire routes", files: ["src/routes/users.js"] },
      reflection: { coherent: true, issues: [], shouldStop: false },
    })
    const out = lines().join("\n")
    expect(out).toContain("chunk 3")
    expect(out).toContain("wire routes")
    expect(out).toContain("✔ last chunk coherent")
  })
})
