import { describe, it, expect } from "vitest"
import { AnthropicProvider } from "../anthropic.js"
import { OpenRouterProvider } from "../openrouter.js"
import type { ProviderPayload } from "../../types.js"

/**
 * Stage B of model-lock-and-portable-reasoning: assert that Anthropic and
 * OpenRouter providers thread `payload.reasoningBrief` and
 * `payload.reasoningElaborationBrief` into the per-request system prompt
 * (the bug this stage closes: today they use the static SHARED_SYSTEM_PROMPT
 * so the brief is computed, cached, and discarded). Gemini already does
 * this; this test pins the new parity in place.
 */

function makePayload(overrides: Partial<ProviderPayload> = {}): ProviderPayload {
  return {
    model: "claude-sonnet",
    runId: "test-run",
    userMessage: "build a tic-tac-toe game in react",
    directoryTree: [],
    context: {},
    cwd: "/tmp/test",
    ...overrides,
  }
}

function makeImplementBrief() {
  return {
    pipeline: "implement" as const,
    confidence: "HIGH" as const,
    decision: "proceed" as const,
    missingContext: [],
    reasoningTrace: "test reasoning trace",
    implementBrief: {
      intent: "build a small browser game",
      subcomponents: [],
      recommendedStack: {
        language: "TypeScript",
        frameworks: ["React"],
        libraries: [],
        rationale: "React handles the small UI well",
      },
      architectureSketch: "single-file App component with hooks",
      buildPlan: [],
      edgeCases: [],
      consistencyNotes: [],
    },
  }
}

function makeBugBrief() {
  return {
    pipeline: "bug" as const,
    confidence: "MEDIUM" as const,
    decision: "proceed" as const,
    missingContext: [],
    reasoningTrace: "test bug reasoning",
    bugBrief: {
      symptom: "import fails to resolve",
      suspectedBoundary: "build-system",
      hypotheses: [
        { hypothesis: "wrong path", probability: "HIGH", invalidatingTest: "check tsconfig" },
      ],
      proposedFix: { scope: "single-file", description: "fix the import path" },
      sideEffects: [],
    },
  }
}

function makeElaborationBrief() {
  return {
    pipeline: "implement_elaborate" as const,
    confidence: "MEDIUM" as const,
    decision: "proceed" as const,
    missingContext: [],
    reasoningTrace: "elaboration",
    implementElaborationBrief: {
      whyThisApproach: "React + hooks is the minimal viable structure for this scope",
      whyNotAlternative: ["redux is overkill for a 3x3 grid"],
      preconditions: ["node 18+"],
      confidence: "MEDIUM" as const,
    },
  }
}

describe("AnthropicProvider.getSystemPromptForRequest — Stage B", () => {
  it("includes the reasoning brief section when payload.reasoningBrief is set (implement)", () => {
    const provider = new AnthropicProvider()
    const payload = makePayload({ reasoningBrief: makeImplementBrief() })
    const sys = provider.getSystemPromptForRequest(payload)

    expect(sys).toContain("REASONING BRIEF")
    expect(sys).toContain("INTENT:")
    expect(sys).toContain("build a small browser game")
    expect(sys).toContain("STACK: TypeScript")
  })

  it("includes the bug-pipeline section when payload.reasoningBrief is a bug brief", () => {
    const provider = new AnthropicProvider()
    const payload = makePayload({ reasoningBrief: makeBugBrief() })
    const sys = provider.getSystemPromptForRequest(payload)

    expect(sys).toContain("REASONING BRIEF")
    expect(sys).toContain("SYMPTOM:")
    expect(sys).toContain("import fails to resolve")
    expect(sys).toContain("HYPOTHESES")
  })

  it("renders the DEEPER REASONING sub-block when elaborationBrief accompanies implement", () => {
    const provider = new AnthropicProvider()
    const payload = makePayload({
      reasoningBrief: makeImplementBrief(),
      reasoningElaborationBrief: makeElaborationBrief(),
    })
    const sys = provider.getSystemPromptForRequest(payload)

    expect(sys).toContain("DEEPER REASONING")
    expect(sys).toContain("WHY THIS APPROACH:")
    expect(sys).toContain("React + hooks is the minimal viable structure")
  })

  it("omits the brief block entirely when no brief is provided (no behavioural regression)", () => {
    const provider = new AnthropicProvider()
    const payload = makePayload()
    const sys = provider.getSystemPromptForRequest(payload)

    expect(sys).not.toContain("REASONING BRIEF")
    expect(sys).not.toContain("DEEPER REASONING")
    // Tools / system rules still render.
    expect(sys.length).toBeGreaterThan(500)
  })
})

describe("OpenRouterProvider.getSystemPromptForRequest — Stage B", () => {
  it("includes the reasoning brief section when payload.reasoningBrief is set", () => {
    const provider = new OpenRouterProvider()
    const payload = makePayload({
      model: "openrouter-auto",
      reasoningBrief: makeImplementBrief(),
    })
    const sys = provider.getSystemPromptForRequest(payload)

    expect(sys).toContain("REASONING BRIEF")
    expect(sys).toContain("INTENT:")
    expect(sys).toContain("build a small browser game")
  })

  it("renders the DEEPER REASONING sub-block when elaboration accompanies implement", () => {
    const provider = new OpenRouterProvider()
    const payload = makePayload({
      model: "openrouter-auto",
      reasoningBrief: makeImplementBrief(),
      reasoningElaborationBrief: makeElaborationBrief(),
    })
    const sys = provider.getSystemPromptForRequest(payload)

    expect(sys).toContain("DEEPER REASONING")
  })

  it("omits the brief block when no brief is provided", () => {
    const provider = new OpenRouterProvider()
    const payload = makePayload({ model: "openrouter-auto" })
    const sys = provider.getSystemPromptForRequest(payload)

    expect(sys).not.toContain("REASONING BRIEF")
  })
})

describe("Stage B parity — same brief produces same brief section across providers", () => {
  it("Anthropic and OpenRouter emit identical brief-section content for the same payload", () => {
    const anthropic = new AnthropicProvider()
    const openrouter = new OpenRouterProvider()
    const payload = makePayload({ reasoningBrief: makeImplementBrief() })

    const aSys = anthropic.getSystemPromptForRequest(payload)
    const oSys = openrouter.getSystemPromptForRequest(payload)

    // Both prompts contain the same brief content (the model-specific tail
    // differs by provider, but the brief block is identical).
    const briefBlockA = aSys.slice(aSys.indexOf("REASONING BRIEF"), aSys.indexOf("REASONING BRIEF") + 600)
    const briefBlockO = oSys.slice(oSys.indexOf("REASONING BRIEF"), oSys.indexOf("REASONING BRIEF") + 600)
    expect(briefBlockA).toBe(briefBlockO)
  })
})
