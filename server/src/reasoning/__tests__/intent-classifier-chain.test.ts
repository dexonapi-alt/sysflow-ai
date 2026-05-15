/**
 * Plan `2026-05-15-llm-iterative-intent-classification.md` Stage 1+2.
 *
 * Self-directing-depth tests for `classifyIntentByChain`. The
 * orchestrator takes a `callBackend` DI parameter so tests inject
 * stubbed LLM responses (canned per-iteration JSON) without touching
 * `fetch` / SDK code. Each test names the iteration sequence it's
 * verifying (commit-after-1, commit-after-2, supersedes-mid-chain,
 * etc.).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  classifyIntentByChain,
  parseIntentClassificationStep,
  buildIntentClassificationUserTurn,
  MAX_INTENT_CLASSIFICATION_ITERATIONS,
  type ClassifyIntentByChainPayload,
  type ClassifyIntentLlmCall,
  type IntentClassificationStep,
} from "../intent-classifier.js"

// Tests run without API keys configured — clear any leaked env so
// `pickReasonerBackend` returns null deterministically on the
// no-backend tests, and set a stub key for the happy-path tests so
// `pickReasonerBackend` picks a backend.
const ORIGINAL_KEYS = {
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
}

beforeEach(() => {
  // Default to Gemini key set so the chain runs. Each test that
  // exercises the no-backend path explicitly unsets all three.
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

const basePayload: ClassifyIntentByChainPayload = {
  userMessage: "build a postgres-backed user API",
  model: "claude-sonnet",
}

/** Build a JSON-string iteration response so test fixtures stay
 *  readable. */
function stepJson(step: Partial<IntentClassificationStep> & { paragraph: string; done: boolean }): string {
  return JSON.stringify({
    paragraph: step.paragraph,
    done: step.done,
    hypothesis: step.hypothesis ?? null,
    confidence: step.confidence ?? null,
    supersedes: step.supersedes ?? null,
  })
}

describe("parseIntentClassificationStep — raw → typed", () => {
  it("parses a well-formed iteration", () => {
    const raw = stepJson({ paragraph: "First reasoning paragraph.", done: true, hypothesis: "implement", confidence: "HIGH" })
    const out = parseIntentClassificationStep(raw)
    expect(out).not.toBeNull()
    expect(out!.paragraph).toBe("First reasoning paragraph.")
    expect(out!.done).toBe(true)
    expect(out!.hypothesis).toBe("implement")
    expect(out!.confidence).toBe("HIGH")
  })

  it("strips ```json markdown fences before parsing", () => {
    const raw = "```json\n" + stepJson({ paragraph: "fenced", done: true, hypothesis: "bug", confidence: "MEDIUM" }) + "\n```"
    const out = parseIntentClassificationStep(raw)
    expect(out).not.toBeNull()
    expect(out!.hypothesis).toBe("bug")
  })

  it("strips bare ``` fences before parsing", () => {
    const raw = "```\n" + stepJson({ paragraph: "bare fence", done: false, hypothesis: null, confidence: null }) + "\n```"
    const out = parseIntentClassificationStep(raw)
    expect(out).not.toBeNull()
    expect(out!.done).toBe(false)
  })

  it("returns null on invalid JSON", () => {
    expect(parseIntentClassificationStep("not json")).toBeNull()
    expect(parseIntentClassificationStep("{ unclosed")).toBeNull()
  })

  it("returns null when hypothesis is out-of-enum", () => {
    const raw = JSON.stringify({ paragraph: "x", done: true, hypothesis: "garbage", confidence: "HIGH" })
    expect(parseIntentClassificationStep(raw)).toBeNull()
  })

  it("returns null when paragraph is empty (schema enforces min 1)", () => {
    const raw = JSON.stringify({ paragraph: "", done: true, hypothesis: "implement", confidence: "HIGH" })
    expect(parseIntentClassificationStep(raw)).toBeNull()
  })

  it("accepts supersedes:null AND omitted", () => {
    const withNull = JSON.stringify({ paragraph: "x", done: false, hypothesis: null, confidence: null, supersedes: null })
    const omitted = JSON.stringify({ paragraph: "x", done: false, hypothesis: null, confidence: null })
    expect(parseIntentClassificationStep(withNull)).not.toBeNull()
    expect(parseIntentClassificationStep(omitted)).not.toBeNull()
  })

  it("accepts supersedes as a non-negative integer", () => {
    const raw = JSON.stringify({ paragraph: "x", done: true, hypothesis: "bug", confidence: "HIGH", supersedes: 0 })
    const out = parseIntentClassificationStep(raw)
    expect(out!.supersedes).toBe(0)
  })

  it("rejects supersedes as a negative number", () => {
    const raw = JSON.stringify({ paragraph: "x", done: true, hypothesis: "bug", confidence: "HIGH", supersedes: -1 })
    expect(parseIntentClassificationStep(raw)).toBeNull()
  })
})

describe("buildIntentClassificationUserTurn — content shape", () => {
  it("first iteration: includes the prompt and the senior-engineer-first-pass instruction", () => {
    const out = buildIntentClassificationUserTurn(basePayload, [], 0, MAX_INTENT_CLASSIFICATION_ITERATIONS)
    expect(out).toContain("ITERATION 1 of up to 6")
    expect(out).toContain("USER PROMPT:")
    expect(out).toContain(basePayload.userMessage)
    expect(out).toContain("This is the FIRST iteration")
    expect(out).toContain("done: true")
    expect(out).not.toContain("PRIOR PARAGRAPHS")
  })

  it("follow-up iteration: includes prior paragraphs with indices", () => {
    const priors = ["First paragraph reasoning.", "Second paragraph reasoning."]
    const out = buildIntentClassificationUserTurn(basePayload, priors, 2, MAX_INTENT_CLASSIFICATION_ITERATIONS)
    expect(out).toContain("ITERATION 3 of up to 6")
    expect(out).toContain("PRIOR PARAGRAPHS")
    expect(out).toContain("[0] First paragraph reasoning.")
    expect(out).toContain("[1] Second paragraph reasoning.")
    expect(out).toContain("supersedes")
    expect(out).not.toContain("This is the FIRST iteration")
  })

  it("always asks for JSON-only output (no markdown fences)", () => {
    const out = buildIntentClassificationUserTurn(basePayload, [], 0, MAX_INTENT_CLASSIFICATION_ITERATIONS)
    expect(out).toContain("Output ONLY the JSON object")
    expect(out).toContain("No markdown fences")
  })
})

describe("classifyIntentByChain — happy path (commit after 1 iteration)", () => {
  it("commits when iter 1 returns done:true HIGH", async () => {
    const stub: ClassifyIntentLlmCall = vi.fn().mockResolvedValueOnce(
      stepJson({
        paragraph: "User asked to `build a postgres-backed user API`. Clear implement intent — verb + concrete artefact. No bug-shape signals. Committing.",
        done: true,
        hypothesis: "implement",
        confidence: "HIGH",
      }),
    )

    const out = await classifyIntentByChain(basePayload, stub)
    expect(out).not.toBeNull()
    expect(out!.hypothesis).toBe("implement")
    expect(out!.confidence).toBe("HIGH")
    expect(out!.iterations).toBe(1)
    expect(out!.committedVia).toBe("done_flag")
    expect(out!.paragraphs).toHaveLength(1)
    expect(stub).toHaveBeenCalledTimes(1)
  })

  it("passes systemInstruction + userTurn to the backend call", async () => {
    const stub = vi.fn().mockResolvedValueOnce(
      stepJson({ paragraph: "p", done: true, hypothesis: "bug", confidence: "HIGH" }),
    )
    await classifyIntentByChain(basePayload, stub)
    const call = stub.mock.calls[0][0]
    // System instruction is the intent-classification pipeline prompt
    expect(call.systemInstruction).toContain("INTENT CLASSIFICATION reasoner")
    expect(call.systemInstruction).toContain("SENIOR-ENGINEER RUBRIC")
    // User turn carries the prompt
    expect(call.userTurn).toContain(basePayload.userMessage)
  })
})

describe("classifyIntentByChain — multi-iteration commit", () => {
  it("iterates twice when iter 1 raises a question (done:false)", async () => {
    const stub = vi.fn()
      .mockResolvedValueOnce(stepJson({
        paragraph: "User said 'make this faster' — could be implement (optimisation) or bug (regression). Need more context.",
        done: false,
        hypothesis: null,
        confidence: null,
      }))
      .mockResolvedValueOnce(stepJson({
        paragraph: "No regression context in the prompt; treating as implement-optimisation.",
        done: true,
        hypothesis: "implement",
        confidence: "MEDIUM",
      }))

    const out = await classifyIntentByChain({ ...basePayload, userMessage: "make this faster" }, stub)
    expect(out).not.toBeNull()
    expect(out!.hypothesis).toBe("implement")
    expect(out!.confidence).toBe("MEDIUM")
    expect(out!.iterations).toBe(2)
    expect(out!.committedVia).toBe("done_flag")
    expect(out!.paragraphs).toHaveLength(2)
    expect(stub).toHaveBeenCalledTimes(2)
  })

  it("threads prior paragraphs into the next iteration's user turn", async () => {
    const stub = vi.fn()
      .mockResolvedValueOnce(stepJson({ paragraph: "First-paragraph reasoning.", done: false, hypothesis: null, confidence: null }))
      .mockResolvedValueOnce(stepJson({ paragraph: "Second-paragraph reasoning.", done: true, hypothesis: "summary", confidence: "HIGH" }))

    await classifyIntentByChain(basePayload, stub)
    const secondCall = stub.mock.calls[1][0]
    expect(secondCall.userTurn).toContain("PRIOR PARAGRAPHS")
    expect(secondCall.userTurn).toContain("[0] First-paragraph reasoning.")
  })

  it("supersedes a prior paragraph instead of stacking", async () => {
    const stub = vi.fn()
      .mockResolvedValueOnce(stepJson({
        paragraph: "First read: this looks like a bug report.",
        done: false,
        hypothesis: null,
        confidence: null,
      }))
      .mockResolvedValueOnce(stepJson({
        paragraph: "Re-reading more carefully — actually implement: the user wants to add error handling as a FEATURE.",
        done: true,
        hypothesis: "implement",
        confidence: "HIGH",
        supersedes: 0,
      }))

    const out = await classifyIntentByChain(basePayload, stub)
    expect(out).not.toBeNull()
    expect(out!.hypothesis).toBe("implement")
    expect(out!.paragraphs).toHaveLength(1)
    expect(out!.paragraphs[0]).toContain("Re-reading more carefully")
    expect(out!.paragraphs[0]).not.toContain("First read: this looks like a bug")
  })
})

describe("classifyIntentByChain — step cap (LLM never commits)", () => {
  it("hits the cap and returns committedVia: step_cap with the last hypothesis", async () => {
    const stub = vi.fn().mockResolvedValue(
      stepJson({
        paragraph: "I'm not sure — let me think more.",
        done: false,
        hypothesis: "bug",
        confidence: "LOW",
      }),
    )

    const out = await classifyIntentByChain(basePayload, stub, /* cap via payload */)
    expect(out).not.toBeNull()
    expect(out!.iterations).toBe(MAX_INTENT_CLASSIFICATION_ITERATIONS)
    expect(out!.committedVia).toBe("step_cap")
    expect(out!.hypothesis).toBe("bug")
    expect(out!.confidence).toBe("LOW")
    expect(stub).toHaveBeenCalledTimes(MAX_INTENT_CLASSIFICATION_ITERATIONS)
  })

  it("honours an overridden maxIterations (testing knob)", async () => {
    const stub = vi.fn().mockResolvedValue(
      stepJson({ paragraph: "still thinking", done: false, hypothesis: "implement", confidence: "LOW" }),
    )

    const out = await classifyIntentByChain(
      { ...basePayload, maxIterations: 2 },
      stub,
    )
    expect(out!.iterations).toBe(2)
    expect(out!.committedVia).toBe("step_cap")
    expect(stub).toHaveBeenCalledTimes(2)
  })

  it("returns null when the chain never produced a hypothesis (LLM kept hypothesis: null)", async () => {
    const stub = vi.fn().mockResolvedValue(
      stepJson({ paragraph: "still unsure", done: false, hypothesis: null, confidence: null }),
    )

    const out = await classifyIntentByChain({ ...basePayload, maxIterations: 2 }, stub)
    expect(out).toBeNull()
  })
})

describe("classifyIntentByChain — graceful degradation", () => {
  it("returns null when no reasoner backend is available (no API keys)", async () => {
    delete process.env.GEMINI_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.OPENROUTER_API_KEY

    const stub = vi.fn().mockResolvedValue(
      stepJson({ paragraph: "p", done: true, hypothesis: "implement", confidence: "HIGH" }),
    )

    const out = await classifyIntentByChain(basePayload, stub)
    expect(out).toBeNull()
    // The stub never got called because the orchestrator short-circuited at pickReasonerBackend.
    expect(stub).not.toHaveBeenCalled()
  })

  it("stops the chain when an iteration throws (network failure / timeout)", async () => {
    const stub = vi.fn()
      .mockResolvedValueOnce(stepJson({
        paragraph: "First reasoning.",
        done: false,
        hypothesis: "implement",
        confidence: "MEDIUM",
      }))
      .mockRejectedValueOnce(new Error("backend HTTP 429"))

    const out = await classifyIntentByChain(basePayload, stub)
    // We still committed with the prior iteration's hypothesis (even though
    // iter 2 failed) — degraded shape, not a hard failure.
    expect(out).not.toBeNull()
    expect(out!.hypothesis).toBe("implement")
    expect(out!.committedVia).toBe("step_cap")
    expect(out!.paragraphs).toHaveLength(1)
  })

  it("stops the chain when an iteration is unparseable", async () => {
    const stub = vi.fn()
      .mockResolvedValueOnce(stepJson({
        paragraph: "First reasoning.",
        done: false,
        hypothesis: "implement",
        confidence: "HIGH",
      }))
      .mockResolvedValueOnce("not valid json")

    const out = await classifyIntentByChain(basePayload, stub)
    expect(out).not.toBeNull()
    expect(out!.hypothesis).toBe("implement")
    expect(out!.confidence).toBe("HIGH")
    expect(out!.paragraphs).toHaveLength(1)
  })

  it("returns null when iter 1 is unparseable (no prior hypothesis to fall back to)", async () => {
    const stub = vi.fn().mockResolvedValueOnce("malformed")
    const out = await classifyIntentByChain(basePayload, stub)
    expect(out).toBeNull()
  })

  it("respects an explicit `reasoning.backend` flagOverride (when key matches)", async () => {
    process.env.ANTHROPIC_API_KEY = "anthropic-key"
    const stub = vi.fn().mockResolvedValueOnce(
      stepJson({ paragraph: "p", done: true, hypothesis: "implement", confidence: "HIGH" }),
    )

    await classifyIntentByChain({ ...basePayload, flagOverride: "anthropic" }, stub)
    expect(stub).toHaveBeenCalledTimes(1)
    expect(stub.mock.calls[0][0].backend).toBe("anthropic")
  })

  it("returns null when flagOverride pins to a backend with no API key", async () => {
    // ANTHROPIC_API_KEY is unset in beforeEach.
    const stub = vi.fn()
    const out = await classifyIntentByChain({ ...basePayload, flagOverride: "anthropic" }, stub)
    expect(out).toBeNull()
    expect(stub).not.toHaveBeenCalled()
  })
})
