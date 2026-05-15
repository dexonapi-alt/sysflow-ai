import { describe, it, expect } from "vitest"
import { formatBriefSummary, formatPlainReasoningChain, pipelineLabelFor } from "../ReasoningPeek.js"

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

describe("formatBriefSummary — implement_elaborate pipeline (Phase 16 Stage 3)", () => {
  it("surfaces whyThisApproach + re-scored confidence", () => {
    const out = formatBriefSummary("implement_elaborate", {
      implementElaborationBrief: {
        whyThisApproach: "Drizzle's typed schema gives the user's strict-typing ask a working foundation",
        whyNotAlternative: ["Express adds middleware overhead we don't need at this scale"],
        preconditions: ["package.json must exist", "DATABASE_URL env var assumed"],
        confidence: "HIGH",
      },
    })
    expect(out.pipelineLabel).toBe("Reasoning(elaborate)")
    expect(out.lines.some((l) => l.includes("Drizzle"))).toBe(true)
    expect(out.lines.some((l) => l.includes("re-scored confidence: HIGH"))).toBe(true)
    expect(out.lines.some((l) => l.includes("preconditions"))).toBe(true)
  })

  it("accepts the brief at the envelope level too (briefData = the elaboration brief itself)", () => {
    const out = formatBriefSummary("implement_elaborate", {
      whyThisApproach: "tight loop wins on free-tier",
      confidence: "MEDIUM",
      preconditions: [],
      whyNotAlternative: [],
    })
    expect(out.lines.some((l) => l.includes("tight loop wins"))).toBe(true)
    expect(out.lines.some((l) => l.includes("re-scored confidence: MEDIUM"))).toBe(true)
  })

  it("falls back to the confidence line when no whyThisApproach is present", () => {
    const out = formatBriefSummary("implement_elaborate", { confidence: "LOW", decision: "proceed" })
    expect(out.lines).toHaveLength(1)
    expect(out.lines[0]).toContain("confidence: LOW")
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

// ─── 2026-05-15: plain-prose preference for the reasoningChain[] field ───

describe("formatBriefSummary — reasoningChain (plain-prose) preference", () => {
  it("renders reasoningChain paragraphs when present, NOT the structured bugBrief fields", () => {
    const out = formatBriefSummary("bug", {
      // Both fields populated: the chain should win.
      reasoningChain: [
        "The user is asking to fix the broken auth flow. The symptom is a 500 after deploy and the prompt cites a missing DATABASE_URL.",
      ],
      bugBrief: {
        // Without the chain-preference, this is what the peek would render.
        symptom: "500 after deploy",
        suspectedBoundary: "config",
        proposedFix: { description: "set DATABASE_URL env var" },
      },
    })
    expect(out.pipelineLabel).toBe("Reasoning(bug)")
    expect(out.lines).toHaveLength(1)
    expect(out.lines[0]).toContain("symptom is a 500")
    // The structured-field renderer would have produced these — confirm
    // the chain path replaced them.
    expect(out.lines.join("\n")).not.toMatch(/^→ symptom: /m)
    expect(out.lines.join("\n")).not.toMatch(/^→ boundary: /m)
    expect(out.lines.join("\n")).not.toMatch(/^→ fix: /m)
  })

  it("works the same for every pipeline kind (label changes, structure doesn't)", () => {
    for (const kind of ["implement", "bug", "decision", "summary", "divergence", "implement_elaborate", "chunk_plan", "chunk_reflect", "intent_classification"]) {
      const out = formatBriefSummary(kind, {
        reasoningChain: ["One reasoning paragraph that fits inside the truncation budget."],
      })
      expect(out.pipelineLabel).toBe(pipelineLabelFor(kind))
      expect(out.lines).toHaveLength(1)
      expect(out.lines[0]).toContain("One reasoning paragraph")
    }
  })

  it("shows up to 3 paragraphs and a +N tail when the chain is longer", () => {
    const out = formatBriefSummary("implement", {
      reasoningChain: [
        "Paragraph 1: restate the user's request.",
        "Paragraph 2: why this approach over alternatives.",
        "Paragraph 3: trade-offs and end-to-end check.",
        "Paragraph 4: a fourth paragraph that should be elided.",
        "Paragraph 5: a fifth paragraph that should be elided.",
      ],
    })
    expect(out.lines).toHaveLength(4) // 3 paragraphs + the "+2 more" line
    expect(out.lines[0]).toContain("Paragraph 1")
    expect(out.lines[1]).toContain("Paragraph 2")
    expect(out.lines[2]).toContain("Paragraph 3")
    expect(out.lines[3]).toContain("+2 more paragraphs")
    expect(out.lines.join(" ")).not.toContain("Paragraph 4")
  })

  it("uses singular 'paragraph' on the tail when exactly one is hidden", () => {
    const out = formatBriefSummary("implement", {
      reasoningChain: ["one", "two", "three", "four"],
    })
    const tail = out.lines[out.lines.length - 1]
    expect(tail).toContain("+1 more paragraph")
    expect(tail).not.toContain("paragraphs")
  })

  it("truncates a single long paragraph with an ellipsis", () => {
    const long = "x".repeat(500)
    const out = formatBriefSummary("bug", { reasoningChain: [long] })
    expect(out.lines).toHaveLength(1)
    expect(out.lines[0].length).toBeLessThan(long.length)
    expect(out.lines[0].endsWith("…")).toBe(true)
  })

  it("filters non-string and empty / whitespace-only entries before counting", () => {
    const out = formatBriefSummary("implement", {
      reasoningChain: [
        "valid first paragraph",
        "",
        null as unknown as string, // malformed payload defense
        "   ",
        42 as unknown as string,
        "valid second paragraph",
      ],
    })
    expect(out.lines).toHaveLength(2)
    expect(out.lines[0]).toContain("valid first")
    expect(out.lines[1]).toContain("valid second")
  })

  it("falls back to structured-field rendering when reasoningChain is empty or missing", () => {
    // Empty chain → structured fallback fires.
    const emptyChain = formatBriefSummary("bug", {
      reasoningChain: [],
      bugBrief: { symptom: "500 after deploy", suspectedBoundary: "config" },
    })
    expect(emptyChain.lines.some((l) => l.includes("→ symptom:"))).toBe(true)

    // Missing chain → same path.
    const noChain = formatBriefSummary("bug", {
      bugBrief: { symptom: "500 after deploy", suspectedBoundary: "config" },
    })
    expect(noChain.lines.some((l) => l.includes("→ symptom:"))).toBe(true)

    // Non-array chain (malformed payload) → structured fallback fires.
    const malformedChain = formatBriefSummary("bug", {
      reasoningChain: "not an array" as unknown as string[],
      bugBrief: { symptom: "500 after deploy" },
    })
    expect(malformedChain.lines.some((l) => l.includes("→ symptom:"))).toBe(true)
  })

  it("chain with only whitespace / non-string entries falls back to structured rendering", () => {
    const out = formatBriefSummary("bug", {
      reasoningChain: ["", "   ", null as unknown as string, 42 as unknown as string],
      bugBrief: { symptom: "still here" },
    })
    expect(out.lines.some((l) => l.includes("→ symptom: still here"))).toBe(true)
  })
})

describe("formatPlainReasoningChain — pure helper", () => {
  it("returns exactly the paragraphs (truncated) up to the cap", () => {
    const out = formatPlainReasoningChain("implement", ["one", "two"])
    expect(out.lines).toEqual(["→ one", "→ two"])
    expect(out.pipelineLabel).toBe("Reasoning(implement)")
  })

  it("renders the +N tail for hidden paragraphs", () => {
    const out = formatPlainReasoningChain("bug", ["a", "b", "c", "d", "e"])
    expect(out.lines).toHaveLength(4) // cap is 3 + tail
    expect(out.lines[3]).toBe("→ (+2 more paragraphs)")
  })
})

describe("pipelineLabelFor — canonical labels", () => {
  it("returns known labels for each pipeline kind", () => {
    expect(pipelineLabelFor("implement")).toBe("Reasoning(implement)")
    expect(pipelineLabelFor("bug")).toBe("Reasoning(bug)")
    expect(pipelineLabelFor("decision")).toBe("Reasoning(decision)")
    expect(pipelineLabelFor("summary")).toBe("Reasoning(summary)")
    expect(pipelineLabelFor("divergence")).toBe("Reasoning(divergence)")
    expect(pipelineLabelFor("implement_elaborate")).toBe("Reasoning(elaborate)")
    expect(pipelineLabelFor("chunk_plan")).toBe("Reasoning(chunk plan)")
    expect(pipelineLabelFor("chunk_reflect")).toBe("Reasoning(chunk reflect)")
  })

  it("returns a default Reasoning(<kind>) for unknown kinds", () => {
    expect(pipelineLabelFor("intent_classification")).toBe("Reasoning(intent_classification)")
    expect(pipelineLabelFor("future_pipeline")).toBe("Reasoning(future_pipeline)")
  })
})
