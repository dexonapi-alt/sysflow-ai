import { describe, it, expect } from "vitest"
import { getInvestigationSection } from "../investigation.js"
import { getEnvInfoSection } from "../env-info.js"
import { buildSystemPrompt } from "../../build.js"

/**
 * Stage 1 of command-first-investigation: investigation patterns section.
 * Pins the platform-aware rendering + the trivial-task short-circuit
 * guidance + the registration in build.ts.
 */

describe("getInvestigationSection — platform-aware command examples", () => {
  it("renders bash commands when platform is non-Windows (linux/darwin)", () => {
    const linux = getInvestigationSection({ platform: "linux" })
    const darwin = getInvestigationSection({ platform: "darwin" })

    for (const out of [linux, darwin]) {
      expect(out).toContain("INVESTIGATION PATTERNS")
      // bash forms
      expect(out).toContain("ls -la")
      expect(out).toContain("grep -r")
      expect(out).toContain("cat package.json")
      expect(out).toContain("find . -maxdepth")
      // PowerShell forms must NOT leak in
      expect(out).not.toContain("Get-ChildItem")
      expect(out).not.toContain("Select-String")
      expect(out).not.toContain("Get-Content")
    }
  })

  it("renders PowerShell commands when platform is win32", () => {
    const out = getInvestigationSection({ platform: "win32" })

    expect(out).toContain("INVESTIGATION PATTERNS")
    // PowerShell forms
    expect(out).toContain("Get-ChildItem")
    expect(out).toContain("Select-String")
    expect(out).toContain("Get-Content")
    // bash forms must NOT leak in
    expect(out).not.toContain("ls -la")
    expect(out).not.toContain("grep -r")
    expect(out).not.toContain("find . -maxdepth")
  })

  it("includes the three task-shape patterns + trivial short-circuit", () => {
    const out = getInvestigationSection({ platform: "linux" })
    expect(out).toContain("BUG")
    expect(out).toContain("IMPLEMENT")
    expect(out).toContain("EXPLORE")
    expect(out).toContain("TRIVIAL SHORT-CIRCUIT")
    expect(out).toContain("\"fix the typo on line 12 of foo.ts\"")
    expect(out).toContain("Do NOT manufacture a `git status`")
  })

  it("git status / git log appear on every platform (they're universal)", () => {
    for (const platform of ["linux", "darwin", "win32"]) {
      const out = getInvestigationSection({ platform })
      expect(out).toContain("git status")
      expect(out).toContain("git log")
    }
  })
})

describe("env-info — PREFERRED_INVESTIGATION_COMMANDS line", () => {
  it("emits the bash command list on Linux/Mac", () => {
    const out = getEnvInfoSection({ platform: "linux" })
    expect(out).toContain("preferred read-only commands (bash)")
    expect(out).toContain("ls, find, grep, cat, head, tail")
  })

  it("emits the PowerShell command list on Windows", () => {
    const out = getEnvInfoSection({ platform: "win32" })
    expect(out).toContain("preferred read-only commands (PowerShell)")
    expect(out).toContain("Get-ChildItem, Select-String, Get-Content")
  })
})

describe("buildSystemPrompt — investigation section is wired in", () => {
  it("registered section appears in the assembled prompt", () => {
    const built = buildSystemPrompt({ platform: "linux", model: "gemini-flash" })
    expect(built.full).toContain("═══ INVESTIGATION PATTERNS ═══")
  })

  it("renders BEFORE the reasoning_brief section (priority 102 < 107) when both are present", () => {
    const built = buildSystemPrompt({
      platform: "linux",
      reasoningBrief: {
        pipeline: "implement",
        confidence: "HIGH",
        decision: "proceed",
        missingContext: [],
        reasoningTrace: "x",
        reasoningChain: [],
        implementBrief: {
          intent: "x",
          subcomponents: [],
          recommendedStack: { language: "ts", frameworks: [], libraries: [], rationale: "" },
          architectureSketch: "",
          buildPlan: [],
          edgeCases: [],
          consistencyNotes: [],
        },
      },
    })
    const invIdx = built.full.indexOf("INVESTIGATION PATTERNS")
    const briefIdx = built.full.indexOf("REASONING BRIEF")
    expect(invIdx).toBeGreaterThan(0)
    expect(briefIdx).toBeGreaterThan(invIdx)
  })
})
