import { describe, it, expect } from "vitest"
import { formatBriefSummary } from "../ReasoningPeek.js"

describe("formatBriefSummary — implement pipeline", () => {
  it("surfaces the intent + recommended stack", () => {
    const out = formatBriefSummary("implement", {
      implementBrief: {
        intent: "build a postgres-backed user API",
        recommendedStack: { language: "TypeScript", frameworks: ["Fastify"], libraries: ["drizzle-orm", "zod"] },
      },
    })
    expect(out.pipelineLabel).toBe("Reasoning(implement)")
    expect(out.lines).toHaveLength(2)
    expect(out.lines[0]).toContain("postgres-backed user API")
    expect(out.lines[1]).toContain("TypeScript")
    expect(out.lines[1]).toContain("Fastify")
    expect(out.lines[1]).toContain("drizzle-orm")
  })

  it("falls back to confidence line when implementBrief is missing", () => {
    const out = formatBriefSummary("implement", { confidence: "MEDIUM", decision: "proceed" })
    expect(out.lines).toHaveLength(1)
    expect(out.lines[0]).toContain("confidence: MEDIUM")
    expect(out.lines[0]).toContain("decision: proceed")
  })

  it("caps long intents with an ellipsis", () => {
    const intent = "build " + "x".repeat(200)
    const out = formatBriefSummary("implement", { implementBrief: { intent } })
    const intentLine = out.lines[0]
    expect(intentLine.length).toBeLessThan(intent.length + 4)
    expect(intentLine.endsWith("…")).toBe(true)
  })

  it("caps the stack composition at 5 components for readability", () => {
    const out = formatBriefSummary("implement", {
      implementBrief: {
        recommendedStack: {
          language: "Python",
          frameworks: ["Django", "FastAPI"],
          libraries: ["sqlalchemy", "pydantic", "alembic", "uvicorn", "redis"],
        },
      },
    })
    const stackLine = out.lines.find((l) => l.includes("stack:"))!
    // Comma-style split: 5 maximum tokens between the +'s
    const tokens = stackLine.split(" + ")
    expect(tokens.length).toBeLessThanOrEqual(5)
  })
})

describe("formatBriefSummary — bug pipeline", () => {
  it("surfaces symptom + boundary + fix", () => {
    const out = formatBriefSummary("bug", {
      bugBrief: {
        symptom: "500 after deploy",
        suspectedBoundary: "config",
        proposedFix: { description: "set DATABASE_URL env var" },
      },
    })
    expect(out.pipelineLabel).toBe("Reasoning(bug)")
    expect(out.lines).toHaveLength(3)
    expect(out.lines[0]).toContain("500 after deploy")
    expect(out.lines[1]).toContain("config")
    expect(out.lines[2]).toContain("DATABASE_URL")
  })
})

describe("formatBriefSummary — decision pipeline", () => {
  it("surfaces recommendation + proceedHint", () => {
    const out = formatBriefSummary("decision", {
      decisionBrief: { recommendation: "use Drizzle", proceedHint: "install drizzle-orm" },
    })
    expect(out.pipelineLabel).toBe("Reasoning(decision)")
    expect(out.lines).toHaveLength(2)
    expect(out.lines[0]).toContain("Drizzle")
    expect(out.lines[1]).toContain("drizzle-orm")
  })
})

describe("formatBriefSummary — summary pipeline", () => {
  it("surfaces cluster headings (max 3)", () => {
    const out = formatBriefSummary("summary", {
      summaryBrief: {
        clusters: [
          { heading: "What changed" },
          { heading: "Why" },
          { heading: "Tests" },
          { heading: "Follow-ups" },
        ],
      },
    })
    expect(out.pipelineLabel).toBe("Reasoning(summary)")
    expect(out.lines[0]).toContain("What changed")
    expect(out.lines[0]).toContain("Why")
    expect(out.lines[0]).toContain("Tests")
    expect(out.lines[0]).not.toContain("Follow-ups")
  })
})

describe("formatBriefSummary — divergence pipeline (Phase 11)", () => {
  it("surfaces onTrack + score + first mismatch", () => {
    const out = formatBriefSummary("divergence", {
      divergenceVerdictBrief: {
        onTrack: false,
        score: 35,
        mismatches: ["user asked for postgres but implementation imports mongoose"],
      },
    })
    expect(out.pipelineLabel).toBe("Reasoning(divergence)")
    expect(out.lines).toHaveLength(3)
    expect(out.lines[0]).toContain("on track: no")
    expect(out.lines[1]).toContain("35")
    expect(out.lines[2]).toContain("mongoose")
  })
})

describe("formatBriefSummary — chunk pipelines (Phase 10)", () => {
  it("chunk_plan surfaces nextAction", () => {
    const out = formatBriefSummary("chunk_plan", { chunkPlanBrief: { nextAction: "wire up routes" } })
    expect(out.pipelineLabel).toBe("Reasoning(chunk plan)")
    expect(out.lines[0]).toContain("wire up routes")
  })

  it("chunk_reflect surfaces coherent + nextFocus", () => {
    const out = formatBriefSummary("chunk_reflect", {
      chunkReflectionBrief: { coherent: false, nextFocus: "fix the broken import" },
    })
    expect(out.pipelineLabel).toBe("Reasoning(chunk reflect)")
    expect(out.lines).toHaveLength(2)
    expect(out.lines[0]).toContain("coherent: no")
    expect(out.lines[1]).toContain("broken import")
  })

  it("chunk_reflect skips empty nextFocus", () => {
    const out = formatBriefSummary("chunk_reflect", { chunkReflectionBrief: { coherent: true, nextFocus: "" } })
    expect(out.lines).toHaveLength(1)
    expect(out.lines[0]).toContain("coherent: yes")
  })
})

describe("formatBriefSummary — unknown / simple pipeline", () => {
  it("falls through to a generic confidence/decision line", () => {
    const out = formatBriefSummary("simple", { confidence: "HIGH", decision: "proceed" })
    expect(out.pipelineLabel).toBe("Reasoning(simple)")
    expect(out.lines).toHaveLength(1)
    expect(out.lines[0]).toContain("confidence: HIGH")
  })

  it("never returns an empty lines array — always at least the fallback", () => {
    const out = formatBriefSummary("totally_unknown", {})
    expect(out.lines.length).toBeGreaterThanOrEqual(1)
  })

  it("uses ? placeholders when the brief is empty", () => {
    const out = formatBriefSummary("simple", {})
    expect(out.lines[0]).toContain("?")
  })
})
