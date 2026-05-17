/**
 * Plan `2026-05-15-agent-runtime-fixes-and-project-init-reasoning.md` Stage 1.
 *
 * Tests for the iterative project-init reasoning chain. The orchestrator
 * takes a `callBackend` DI parameter so tests inject canned per-iteration
 * JSON responses without touching `fetch` / SDK code.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import {
  runProjectInitChain,
  parseProjectInitStep,
  buildProjectInitUserTurn,
  renderDirectoryTreeForReasoner,
  MAX_PROJECT_INIT_ITERATIONS,
  type ProjectInitPayload,
  type ProjectInitLlmCall,
  type ProjectInitStep,
} from "../project-init-reasoner.js"

const ORIGINAL_KEYS = {
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
}

beforeEach(() => {
  process.env.GEMINI_API_KEY = "test-key"
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.OPENROUTER_API_KEY
})

afterEach(() => {
  for (const [k, v] of Object.entries(ORIGINAL_KEYS)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

const emptyPayload: ProjectInitPayload = {
  directoryTree: [],
  userMessage: "build a Node.js Express PostgreSQL backend for a simple POS system",
  platform: "win32",
  model: "claude-sonnet",
}

const largeRepoPayload: ProjectInitPayload = {
  directoryTree: [
    { name: "package.json", type: "file" },
    { name: ".git", type: "directory" },
    { name: "src", type: "directory" },
    { name: "tests", type: "directory" },
    { name: "README.md", type: "file" },
    ...Array.from({ length: 60 }, (_, i) => ({ name: `src/file${i}.ts`, type: "file" as const })),
  ],
  userMessage: "add a new endpoint to the user service",
  platform: "linux",
  model: "claude-sonnet",
}

function stepJson(step: Partial<ProjectInitStep> & { paragraph: string; done: boolean }): string {
  // Stage 4 follow-up: expectedArtifacts default = [] for backward compat.
  return JSON.stringify({
    paragraph: step.paragraph,
    done: step.done,
    repoState: step.repoState ?? null,
    fileCount: step.fileCount ?? null,
    keyMarkers: step.keyMarkers ?? [],
    investigationPlan: step.investigationPlan ?? [],
    skipConfigVerificationFor: step.skipConfigVerificationFor ?? [],
    expectedArtifacts: step.expectedArtifacts ?? [],
    confidence: step.confidence ?? null,
    supersedes: step.supersedes ?? null,
  })
}

describe("parseProjectInitStep — raw → typed", () => {
  it("parses a well-formed iteration", () => {
    const raw = stepJson({
      paragraph: "Empty directory. Fresh scaffold required.",
      done: true,
      repoState: "empty",
      fileCount: 0,
      keyMarkers: [],
      investigationPlan: ["ls -la"],
      skipConfigVerificationFor: ["tsconfig.json", ".eslintrc.json"],
      confidence: "HIGH",
    })
    const out = parseProjectInitStep(raw)
    expect(out).not.toBeNull()
    expect(out!.repoState).toBe("empty")
    expect(out!.fileCount).toBe(0)
    expect(out!.skipConfigVerificationFor).toEqual(["tsconfig.json", ".eslintrc.json"])
  })

  it("strips markdown code fences", () => {
    const wrapped = "```json\n" + stepJson({ paragraph: "x", done: true, repoState: "empty", fileCount: 0, confidence: "HIGH" }) + "\n```"
    const out = parseProjectInitStep(wrapped)
    expect(out).not.toBeNull()
    expect(out!.repoState).toBe("empty")
  })

  it("returns null on malformed JSON", () => {
    expect(parseProjectInitStep("not json at all")).toBeNull()
    expect(parseProjectInitStep("{ unclosed")).toBeNull()
  })

  it("returns null when required fields are wrong shape", () => {
    const bad = JSON.stringify({ paragraph: "x", done: true, repoState: "invalid-state", fileCount: 0, confidence: "HIGH" })
    expect(parseProjectInitStep(bad)).toBeNull()
  })

  it("accepts done: false with null typed fields (mid-chain)", () => {
    const raw = stepJson({
      paragraph: "Stub directory. Need to check README.",
      done: false,
      repoState: null as never,
      fileCount: null as never,
      confidence: null as never,
    })
    const out = parseProjectInitStep(raw)
    expect(out).not.toBeNull()
    expect(out!.done).toBe(false)
    expect(out!.repoState).toBeNull()
  })
})

describe("renderDirectoryTreeForReasoner", () => {
  it("renders empty tree as a clear marker", () => {
    const out = renderDirectoryTreeForReasoner([])
    expect(out).toContain("empty")
  })

  it("sorts directories before files", () => {
    const out = renderDirectoryTreeForReasoner([
      { name: "foo.ts", type: "file" },
      { name: "src", type: "directory" },
    ])
    const lines = out.split("\n")
    expect(lines[0]).toContain("src")
    expect(lines[1]).toContain("foo.ts")
  })

  it("caps at TREE_PREVIEW_CAP entries and notes the truncation", () => {
    const tree = Array.from({ length: 300 }, (_, i) => ({ name: `file${i}.ts`, type: "file" as const }))
    const out = renderDirectoryTreeForReasoner(tree)
    expect(out).toContain("more entries omitted")
  })
})

describe("buildProjectInitUserTurn", () => {
  it("includes the user prompt + platform + tree", () => {
    const turn = buildProjectInitUserTurn(emptyPayload, [], 0, 3)
    expect(turn).toContain("ITERATION 1")
    expect(turn).toContain("USER PROMPT:")
    expect(turn).toContain("Node.js Express PostgreSQL")
    expect(turn).toContain("PLATFORM: win32")
    expect(turn).toContain("DIRECTORY TREE (0 entries)")
  })

  it("includes prior paragraphs on follow-up iterations", () => {
    const turn = buildProjectInitUserTurn(emptyPayload, ["first paragraph", "second paragraph"], 2, 3)
    expect(turn).toContain("PRIOR PARAGRAPHS")
    expect(turn).toContain("[0] first paragraph")
    expect(turn).toContain("[1] second paragraph")
    expect(turn).toContain("follow-up iteration")
  })

  it("ends with the JSON-only instruction", () => {
    const turn = buildProjectInitUserTurn(emptyPayload, [], 0, 3)
    expect(turn).toContain("Output ONLY the JSON object")
  })
})

describe("runProjectInitChain — orchestrator", () => {
  it("commits on a single iteration when LLM sets done: true", async () => {
    const callBackend: ProjectInitLlmCall = async () => stepJson({
      paragraph: "Empty directory. Fresh scaffold required.",
      done: true,
      repoState: "empty",
      fileCount: 0,
      keyMarkers: [],
      investigationPlan: ["ls -la"],
      skipConfigVerificationFor: ["tsconfig.json", ".eslintrc.json"],
      confidence: "HIGH",
    })

    const brief = await runProjectInitChain(emptyPayload, callBackend)
    expect(brief).not.toBeNull()
    expect(brief!.repoState).toBe("empty")
    expect(brief!.iterations).toBe(1)
    expect(brief!.committedVia).toBe("done_flag")
    expect(brief!.skipConfigVerificationFor).toEqual(["tsconfig.json", ".eslintrc.json"])
    expect(brief!.confidence).toBe("HIGH")
  })

  it("classifies existing-large repo and produces no skip list", async () => {
    const callBackend: ProjectInitLlmCall = async () => stepJson({
      paragraph: "65 entries with package.json + src/ + tests/. Existing large project.",
      done: true,
      repoState: "existing-large",
      fileCount: 65,
      keyMarkers: ["package.json", "src/", "tests/", ".git/"],
      investigationPlan: ["cat package.json", "ls src/", "grep -r 'user service' src/"],
      skipConfigVerificationFor: [],
      confidence: "HIGH",
    })

    const brief = await runProjectInitChain(largeRepoPayload, callBackend)
    expect(brief).not.toBeNull()
    expect(brief!.repoState).toBe("existing-large")
    expect(brief!.skipConfigVerificationFor).toEqual([])
    expect(brief!.investigationPlan.length).toBe(3)
  })

  it("iterates when first pass returns done: false then commits on second", async () => {
    let call = 0
    const callBackend: ProjectInitLlmCall = async () => {
      call += 1
      if (call === 1) {
        return stepJson({
          paragraph: "12 entries but no manifest. Stub or scripts folder?",
          done: false,
        })
      }
      return stepJson({
        paragraph: "README mentions Express plans — fresh stub.",
        done: true,
        repoState: "small",
        fileCount: 12,
        keyMarkers: ["README.md"],
        investigationPlan: ["cat README.md", "ls"],
        skipConfigVerificationFor: ["tsconfig.json"],
        confidence: "MEDIUM",
      })
    }

    const brief = await runProjectInitChain({ ...emptyPayload, directoryTree: Array.from({ length: 12 }, (_, i) => ({ name: `f${i}`, type: "file" as const })) }, callBackend)
    expect(brief).not.toBeNull()
    expect(brief!.iterations).toBe(2)
    expect(brief!.repoState).toBe("small")
    expect(brief!.committedVia).toBe("done_flag")
  })

  it("stops at the iteration cap and returns brief with committedVia=step_cap", async () => {
    const callBackend: ProjectInitLlmCall = async () => stepJson({
      paragraph: "Still ambiguous after another look.",
      done: false,
      repoState: "small",
      fileCount: 8,
      keyMarkers: ["README"],
      investigationPlan: ["ls"],
      confidence: "LOW",
    })

    const brief = await runProjectInitChain(emptyPayload, callBackend)
    expect(brief).not.toBeNull()
    expect(brief!.iterations).toBe(MAX_PROJECT_INIT_ITERATIONS)
    expect(brief!.committedVia).toBe("step_cap")
  })

  it("returns null when every iteration is unparseable", async () => {
    const callBackend: ProjectInitLlmCall = async () => "not even json"
    const brief = await runProjectInitChain(emptyPayload, callBackend)
    expect(brief).toBeNull()
  })

  it("returns null when no backend API key is set", async () => {
    delete process.env.GEMINI_API_KEY
    const callBackend: ProjectInitLlmCall = async () => "irrelevant"
    const brief = await runProjectInitChain(emptyPayload, callBackend)
    expect(brief).toBeNull()
  })

  it("returns null when chain finishes without a committed repoState", async () => {
    const callBackend: ProjectInitLlmCall = async () => stepJson({
      paragraph: "Still thinking.",
      done: false,
    })
    const brief = await runProjectInitChain(emptyPayload, callBackend)
    expect(brief).toBeNull()
  })

  it("respects supersedes by replacing the prior paragraph in-place", async () => {
    let call = 0
    const callBackend: ProjectInitLlmCall = async () => {
      call += 1
      if (call === 1) {
        return stepJson({
          paragraph: "First take: looks empty.",
          done: false,
        })
      }
      return stepJson({
        paragraph: "Revised: actually a stub project — README references package.json plans.",
        done: true,
        repoState: "small",
        fileCount: 3,
        confidence: "MEDIUM",
        supersedes: 0,
      })
    }
    const brief = await runProjectInitChain(emptyPayload, callBackend)
    expect(brief).not.toBeNull()
    expect(brief!.paragraphs.length).toBe(1)
    expect(brief!.paragraphs[0]).toContain("Revised")
  })

  it("respects payload.maxIterations override (clamped)", async () => {
    let call = 0
    const callBackend: ProjectInitLlmCall = async () => {
      call += 1
      return stepJson({
        paragraph: `iter ${call}`,
        done: false,
        repoState: "empty",
        fileCount: 0,
        confidence: "LOW",
      })
    }
    const brief = await runProjectInitChain({ ...emptyPayload, maxIterations: 2 }, callBackend)
    expect(brief).not.toBeNull()
    expect(brief!.iterations).toBe(2)
  })
})

// ─── Stage 4 follow-up of agent-code-correctness plan: expectedArtifacts schema ───

describe("project-init reasoner — expectedArtifacts field", () => {
  it("commits expectedArtifacts when the LLM includes them in the step", async () => {
    const callBackend: ProjectInitLlmCall = async () => stepJson({
      paragraph: "User wants a PG backend with tests.",
      done: true,
      repoState: "empty",
      fileCount: 0,
      keyMarkers: [],
      investigationPlan: ["ls -la"],
      expectedArtifacts: ["db_schema", "tests"],
      confidence: "HIGH",
    })
    const brief = await runProjectInitChain({
      directoryTree: [],
      userMessage: "build a PG backend with tests",
      platform: "linux",
      model: "claude-sonnet",
    }, callBackend)
    expect(brief).not.toBeNull()
    expect(brief!.expectedArtifacts).toEqual(["db_schema", "tests"])
  })

  it("commits empty expectedArtifacts when LLM decides no artifacts required (the common case)", async () => {
    const callBackend: ProjectInitLlmCall = async () => stepJson({
      paragraph: "User wants a CLI tool. No DB / tests requested.",
      done: true,
      repoState: "empty",
      fileCount: 0,
      keyMarkers: [],
      investigationPlan: ["ls -la"],
      expectedArtifacts: [],
      confidence: "HIGH",
    })
    const brief = await runProjectInitChain({
      directoryTree: [],
      userMessage: "build a CLI tool",
      platform: "linux",
      model: "claude-sonnet",
    }, callBackend)
    expect(brief).not.toBeNull()
    expect(brief!.expectedArtifacts).toEqual([])
  })

  it("commits prisma_schema specifically when prompt explicitly mentions Prisma", async () => {
    const callBackend: ProjectInitLlmCall = async () => stepJson({
      paragraph: "User wants Prisma-based app.",
      done: true,
      repoState: "empty",
      fileCount: 0,
      keyMarkers: [],
      investigationPlan: ["ls -la"],
      expectedArtifacts: ["prisma_schema"],
      confidence: "HIGH",
    })
    const brief = await runProjectInitChain({
      directoryTree: [],
      userMessage: "build a Prisma app",
      platform: "linux",
      model: "claude-sonnet",
    }, callBackend)
    expect(brief).not.toBeNull()
    expect(brief!.expectedArtifacts).toEqual(["prisma_schema"])
  })

  it("rejects expectedArtifacts entries not in the enum (defensive parse)", () => {
    const raw = stepJson({
      paragraph: "x",
      done: true,
      repoState: "empty",
      fileCount: 0,
      confidence: "HIGH",
      expectedArtifacts: ["db_schema", "not_a_real_kind" as never],
    })
    // Schema rejects → parser returns null.
    const out = parseProjectInitStep(raw)
    expect(out).toBeNull()
  })

  it("defaults to empty array when expectedArtifacts is absent (legacy LLM output)", () => {
    const raw = JSON.stringify({
      paragraph: "x",
      done: true,
      repoState: "empty",
      fileCount: 0,
      keyMarkers: [],
      investigationPlan: ["ls"],
      skipConfigVerificationFor: [],
      confidence: "HIGH",
      supersedes: null,
      // expectedArtifacts deliberately absent
    })
    const out = parseProjectInitStep(raw)
    expect(out).not.toBeNull()
    expect(out!.expectedArtifacts).toEqual([])
  })
})
