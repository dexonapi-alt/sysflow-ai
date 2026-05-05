import { describe, it, expect } from "vitest"
import { recommendScaffold, type ReasoningEnvelopeMinimal } from "../recommender.js"

const briefImplement = (
  confidence: "HIGH" | "MEDIUM" | "LOW",
  stack: { language?: string; frameworks?: string[]; libraries?: string[] },
): ReasoningEnvelopeMinimal => ({
  pipeline: "implement",
  confidence,
  implementBrief: { recommendedStack: stack, intent: "test" },
})

describe("recommendScaffold", () => {
  it("HIGH confidence + React+Vite + empty cwd → shouldScaffold=true, autoTrust=false (Vite-family is opt-in)", () => {
    const r = recommendScaffold({
      brief: briefImplement("HIGH", { language: "TypeScript", frameworks: ["React", "Vite"], libraries: [] }),
      userMessage: "create a react app for a todo list",
      cwd: "/projects/empty",
      directoryTree: [],
    })
    expect(r.shouldScaffold).toBe(true)
    expect(r.scaffolder?.stackKey).toBe("react-vite")
    // Vite-family scaffolders are detected but NOT auto-trusted — the agent
    // hand-writes those files instead of spawning `npm create vite`.
    expect(r.autoTrust).toBe(false)
    expect(r.projectName).toBe("todo-list")
  })

  it("HIGH confidence + NestJS → autoTrust=true", () => {
    const r = recommendScaffold({
      brief: briefImplement("HIGH", { language: "TypeScript", frameworks: ["NestJS"] }),
      userMessage: "create a nestjs api",
      directoryTree: [],
    })
    expect(r.shouldScaffold).toBe(true)
    expect(r.scaffolder?.stackKey).toBe("nestjs")
    expect(r.autoTrust).toBe(true)
  })

  it("MEDIUM confidence on single match → shouldScaffold=true but autoTrust=false", () => {
    const r = recommendScaffold({
      brief: briefImplement("MEDIUM", { language: "TypeScript", frameworks: ["React", "Vite"] }),
      userMessage: "build a thing",
      directoryTree: [],
    })
    expect(r.shouldScaffold).toBe(true)
    expect(r.autoTrust).toBe(false)
  })

  it("Express stack → shouldScaffold=false (not in registry)", () => {
    const r = recommendScaffold({
      brief: briefImplement("HIGH", { language: "TypeScript", frameworks: ["Express"] }),
      userMessage: "create an express api",
      directoryTree: [],
    })
    expect(r.shouldScaffold).toBe(false)
    expect(r.candidates).toEqual([])
  })

  it("Discord.js → shouldScaffold=false (no scaffolder)", () => {
    const r = recommendScaffold({
      brief: briefImplement("HIGH", { language: "TypeScript", frameworks: [], libraries: ["discord.js"] }),
      userMessage: "build a discord bot",
      directoryTree: [],
    })
    expect(r.shouldScaffold).toBe(false)
  })

  it("existing project (5 files in cwd) → shouldScaffold=false", () => {
    const r = recommendScaffold({
      brief: briefImplement("HIGH", { language: "TypeScript", frameworks: ["React", "Vite"] }),
      userMessage: "add a feature",
      directoryTree: [
        { name: "package.json", type: "file" },
        { name: "src", type: "directory" },
        { name: "README.md", type: "file" },
        { name: "tsconfig.json", type: "file" },
        { name: "vite.config.ts", type: "file" },
      ],
    })
    expect(r.shouldScaffold).toBe(false)
    expect(r.reason).toMatch(/existing project/)
  })

  it("ignores sysbase entries when checking emptiness", () => {
    const r = recommendScaffold({
      brief: briefImplement("HIGH", { language: "TypeScript", frameworks: ["React", "Vite"] }),
      userMessage: "create a react app",
      directoryTree: [{ name: "sysbase", type: "directory" }],
    })
    expect(r.shouldScaffold).toBe(true)
  })

  it("multiple matches → autoTrust=false, candidates populated", () => {
    const r = recommendScaffold({
      brief: briefImplement("HIGH", { language: "TypeScript", frameworks: ["React"] }),
      userMessage: "create a next.js app with react",
      directoryTree: [],
    })
    // userMessage seeds 'next' which adds nextjs to candidates alongside react-vite
    expect(r.candidates.length).toBeGreaterThanOrEqual(2)
    expect(r.autoTrust).toBe(false)
  })

  it("returns empty when brief is null", () => {
    const r = recommendScaffold({
      brief: null,
      userMessage: "create a react app",
      directoryTree: [],
    })
    expect(r.shouldScaffold).toBe(false)
    expect(r.reason).toMatch(/no implement brief/)
  })

  it("returns empty when brief pipeline is bug not implement", () => {
    const r = recommendScaffold({
      brief: { pipeline: "bug", confidence: "HIGH" },
      userMessage: "fix something",
      directoryTree: [],
    })
    expect(r.shouldScaffold).toBe(false)
  })

  it("user message seeds tokens when reasoner under-lists", () => {
    // Reasoner only lists TypeScript; user said "tauri"
    const r = recommendScaffold({
      brief: briefImplement("HIGH", { language: "TypeScript" }),
      userMessage: "build a tauri desktop app",
      directoryTree: [],
    })
    expect(r.shouldScaffold).toBe(true)
    expect(r.scaffolder?.stackKey).toBe("tauri")
  })
})
