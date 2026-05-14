import { describe, it, expect } from "vitest"
import { detectDivergence, type DetectorInput } from "../divergence-detector.js"
import { isSafeReadOnlyCommand } from "../safe-commands.js"

/**
 * Stage 4 of command-first-investigation: no_investigation_before_write
 * heuristic + server-side safe-commands mirror.
 */

function baseInput(overrides: Partial<DetectorInput> = {}): DetectorInput {
  return {
    originalPrompt: "build a tic-tac-toe game",
    chunkHistory: [],
    filesModified: [],
    toolErrorCounts: new Map(),
    createdDirs: [],
    completionMessage: null,
    plannedChunkCount: null,
    investigationCommandCount: 0,
    firstWriteOrEditIndex: -1,
    complexity: "medium",
    ...overrides,
  }
}

describe("no_investigation_before_write heuristic", () => {
  it("fires when first write happened with zero investigation commands prior", () => {
    const sigs = detectDivergence(baseInput({
      filesModified: ["src/App.tsx"],
      firstWriteOrEditIndex: 0,
      investigationCommandCount: 0,
      complexity: "medium",
    }))
    expect(sigs.some((s) => s.category === "no_investigation_before_write")).toBe(true)
  })

  it("does NOT fire when investigation commands ran before the first write", () => {
    const sigs = detectDivergence(baseInput({
      filesModified: ["src/App.tsx"],
      firstWriteOrEditIndex: 2,
      investigationCommandCount: 2,
    }))
    expect(sigs.some((s) => s.category === "no_investigation_before_write")).toBe(false)
  })

  it("does NOT fire when no write has happened yet (firstWriteOrEditIndex = -1)", () => {
    const sigs = detectDivergence(baseInput({
      firstWriteOrEditIndex: -1,
      investigationCommandCount: 0,
    }))
    expect(sigs.some((s) => s.category === "no_investigation_before_write")).toBe(false)
  })

  it("suppresses on trivial complexity (anti-overfire on simple tasks)", () => {
    const sigs = detectDivergence(baseInput({
      filesModified: ["src/App.tsx"],
      firstWriteOrEditIndex: 0,
      investigationCommandCount: 0,
      complexity: "simple",
    }))
    expect(sigs.some((s) => s.category === "no_investigation_before_write")).toBe(false)
  })

  it("fires for medium AND complex (the genuinely-multi-file cases)", () => {
    for (const c of ["medium" as const, "complex" as const]) {
      const sigs = detectDivergence(baseInput({
        filesModified: ["src/App.tsx"],
        firstWriteOrEditIndex: 0,
        investigationCommandCount: 0,
        complexity: c,
      }))
      expect(sigs.some((s) => s.category === "no_investigation_before_write")).toBe(true)
    }
  })

  it("emits severity: minor (mild signal — investigation is preferred, not required)", () => {
    const sigs = detectDivergence(baseInput({
      filesModified: ["src/App.tsx"],
      firstWriteOrEditIndex: 0,
      investigationCommandCount: 0,
    }))
    const sig = sigs.find((s) => s.category === "no_investigation_before_write")
    expect(sig?.severity).toBe("minor")
  })

  it("defensive: undefined complexity defaults to firing (don't accidentally skip)", () => {
    const sigs = detectDivergence(baseInput({
      filesModified: ["src/App.tsx"],
      firstWriteOrEditIndex: 0,
      investigationCommandCount: 0,
      complexity: null,
    }))
    expect(sigs.some((s) => s.category === "no_investigation_before_write")).toBe(true)
  })
})

describe("server-side isSafeReadOnlyCommand mirror", () => {
  it("matches the cli-client allowlist for canonical investigation commands", () => {
    expect(isSafeReadOnlyCommand("git status")).toBe(true)
    expect(isSafeReadOnlyCommand("git log -10 --oneline")).toBe(true)
    expect(isSafeReadOnlyCommand("ls -la")).toBe(true)
    expect(isSafeReadOnlyCommand("grep -r foo src/")).toBe(true)
    expect(isSafeReadOnlyCommand("cat package.json")).toBe(true)
    expect(isSafeReadOnlyCommand("Get-ChildItem")).toBe(true)
    expect(isSafeReadOnlyCommand("Select-String -Path src -Pattern foo")).toBe(true)
    expect(isSafeReadOnlyCommand("node --version")).toBe(true)
  })

  it("rejects destructive / chained / unknown commands", () => {
    expect(isSafeReadOnlyCommand("rm file.txt")).toBe(false)
    expect(isSafeReadOnlyCommand("npm install")).toBe(false)
    expect(isSafeReadOnlyCommand("git push")).toBe(false)
    expect(isSafeReadOnlyCommand("ls && rm foo")).toBe(false)
    expect(isSafeReadOnlyCommand("grep foo | head")).toBe(false)
    expect(isSafeReadOnlyCommand("node script.js")).toBe(false)
    expect(isSafeReadOnlyCommand("docker ps")).toBe(false)
  })

  it("rejects empty / non-string", () => {
    expect(isSafeReadOnlyCommand("")).toBe(false)
    expect(isSafeReadOnlyCommand(null)).toBe(false)
    expect(isSafeReadOnlyCommand(undefined)).toBe(false)
    expect(isSafeReadOnlyCommand(42)).toBe(false)
  })
})
