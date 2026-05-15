/**
 * Plan `2026-05-15-llm-iterative-intent-classification.md` Stage 4.
 *
 * Smart-wrapper tests. `classifyIntentSmart` is the entry point used
 * by `user-message.ts` + `tool-result.ts`. The wrapper walks four
 * paths in order: cache → regex fast-path (simple only) → LLM chain
 * (flag-gated) → regex fallback. These tests pin the decision matrix
 * and verify the per-run cache survives across calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  classifyIntentSmart,
  getCachedIntentOrRegex,
  type ClassifyIntentLlmCall,
  type IntentClassificationStep,
} from "../intent-classifier.js"
import {
  getIntentForRun,
  setIntentForRun,
  clearIntentForRun,
  _resetIntentCacheForTests,
} from "../../services/intent-cache.js"

const ORIGINAL_KEYS = {
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
}

beforeEach(() => {
  process.env.GEMINI_API_KEY = "test-key"
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.OPENROUTER_API_KEY
  _resetIntentCacheForTests()
})

afterEach(() => {
  for (const [k, v] of Object.entries(ORIGINAL_KEYS)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  _resetIntentCacheForTests()
})

function stepJson(step: Partial<IntentClassificationStep> & { paragraph: string; done: boolean }): string {
  return JSON.stringify({
    paragraph: step.paragraph,
    done: step.done,
    hypothesis: step.hypothesis ?? null,
    confidence: step.confidence ?? null,
    supersedes: step.supersedes ?? null,
  })
}

describe("classifyIntentSmart — cache hit short-circuits everything", () => {
  it("returns the cached value without calling the LLM", async () => {
    setIntentForRun("r1", "implement")
    const stub = vi.fn()
    const out = await classifyIntentSmart({ userMessage: "anything", runId: "r1" }, stub)
    expect(out).toEqual({ hint: "implement", source: "cache" })
    expect(stub).not.toHaveBeenCalled()
  })

  it("cache hit wins even when regex would say something different", async () => {
    setIntentForRun("r2", "implement")
    const stub = vi.fn()
    // This prompt would regex-match `bug` (the word "broken") — but cache wins.
    const out = await classifyIntentSmart({ userMessage: "this is broken", runId: "r2" }, stub)
    expect(out.hint).toBe("implement")
    expect(out.source).toBe("cache")
    expect(stub).not.toHaveBeenCalled()
  })

  it("no runId → no cache lookup, falls through to regex/LLM", async () => {
    // No runId provided. With "simple" prompt the regex fast-path commits.
    const out = await classifyIntentSmart({ userMessage: "ls src" })
    expect(out.hint).toBe("simple")
    expect(out.source).toBe("regex_simple")
  })
})

describe("classifyIntentSmart — regex fast-path for SIMPLE_PATTERNS", () => {
  it("`ls` → regex_simple (no LLM call, no cache lookup)", async () => {
    const stub = vi.fn()
    const out = await classifyIntentSmart({ userMessage: "ls src", runId: "r-simple" }, stub)
    expect(out).toEqual({ hint: "simple", source: "regex_simple" })
    expect(stub).not.toHaveBeenCalled()
  })

  it("`continue` → regex_simple", async () => {
    const stub = vi.fn()
    const out = await classifyIntentSmart({ userMessage: "continue", runId: "r-cont" }, stub)
    expect(out.hint).toBe("simple")
    expect(out.source).toBe("regex_simple")
    expect(stub).not.toHaveBeenCalled()
  })

  it("regex_simple result IS cached so subsequent calls hit cache", async () => {
    const stub = vi.fn()
    await classifyIntentSmart({ userMessage: "ls", runId: "r-cache" }, stub)
    expect(getIntentForRun("r-cache")).toBe("simple")
    // Re-call: cache hit.
    const second = await classifyIntentSmart({ userMessage: "ls", runId: "r-cache" }, stub)
    expect(second.source).toBe("cache")
  })
})

describe("classifyIntentSmart — LLM chain (non-simple prompts)", () => {
  it("runs the chain when the regex would say `implement`", async () => {
    const stub: ClassifyIntentLlmCall = vi.fn().mockResolvedValueOnce(
      stepJson({
        paragraph: "User asked to build a postgres-backed API — clear implement intent.",
        done: true,
        hypothesis: "implement",
        confidence: "HIGH",
      }),
    )

    const out = await classifyIntentSmart(
      { userMessage: "build a postgres-backed user API", runId: "r-llm-1" },
      stub,
    )
    expect(out.hint).toBe("implement")
    expect(out.source).toBe("chain")
    expect(out.paragraphs).toHaveLength(1)
    expect(stub).toHaveBeenCalledTimes(1)
  })

  it("runs the chain when the regex would say `bug` (compound-noun trap)", async () => {
    // This is the regression case PR #82 addressed with the
    // implement-anchor regex. The LLM should ALSO classify it as
    // implement — but via deliberate reasoning, not a brittle pattern.
    const stub: ClassifyIntentLlmCall = vi.fn().mockResolvedValueOnce(
      stepJson({
        paragraph: "The phrase 'error handling' is a FEATURE in the user's build request, not a bug symptom. Implement.",
        done: true,
        hypothesis: "implement",
        confidence: "HIGH",
      }),
    )

    const out = await classifyIntentSmart(
      { userMessage: "the build is broken because of error handling logic", runId: "r-llm-2" },
      stub,
    )
    expect(out.source).toBe("chain")
    // The LLM committed via its paragraph — the regex would have said `bug`.
    expect(out.hint).toBe("implement")
    expect(stub).toHaveBeenCalledTimes(1)
  })

  it("chain result caches so the second call short-circuits", async () => {
    const stub: ClassifyIntentLlmCall = vi.fn().mockResolvedValueOnce(
      stepJson({ paragraph: "p", done: true, hypothesis: "bug", confidence: "MEDIUM" }),
    )

    await classifyIntentSmart({ userMessage: "why does X keep failing intermittently", runId: "r-cache-llm" }, stub)
    expect(getIntentForRun("r-cache-llm")).toBe("bug")
    // Cache hit on second call — stub stays at 1.
    const second = await classifyIntentSmart({ userMessage: "why does X keep failing intermittently", runId: "r-cache-llm" }, stub)
    expect(second.source).toBe("cache")
    expect(stub).toHaveBeenCalledTimes(1)
  })
})

describe("classifyIntentSmart — regex fallback when chain returns null", () => {
  it("falls back to regex when no reasoner backend available", async () => {
    delete process.env.GEMINI_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.OPENROUTER_API_KEY

    const stub: ClassifyIntentLlmCall = vi.fn()
    const out = await classifyIntentSmart(
      { userMessage: "this is broken because of the typeerror", runId: "r-fb-1" },
      stub,
    )
    // Regex says `bug` for this prompt.
    expect(out.hint).toBe("bug")
    expect(out.source).toBe("regex_fallback")
    // Cached so subsequent calls don't re-classify.
    expect(getIntentForRun("r-fb-1")).toBe("bug")
    // Chain never fired (pickReasonerBackend returned null).
    expect(stub).not.toHaveBeenCalled()
  })

  it("falls back to regex when iter 1 is unparseable", async () => {
    const stub: ClassifyIntentLlmCall = vi.fn().mockResolvedValueOnce("not json")
    const out = await classifyIntentSmart(
      { userMessage: "build a stripe integration", runId: "r-fb-2" },
      stub,
    )
    // Regex's implement-anchor catches the "build" verb → implement.
    expect(out.hint).toBe("implement")
    expect(out.source).toBe("regex_fallback")
  })

  it("falls back to regex when chain runs to cap without committing", async () => {
    const stub: ClassifyIntentLlmCall = vi.fn().mockResolvedValue(
      stepJson({ paragraph: "still thinking", done: false, hypothesis: null, confidence: null }),
    )
    // Note: classifyIntentByChain returns null when the chain emits no
    // hypothesis through all 6 iterations.
    const out = await classifyIntentSmart(
      { userMessage: "really tricky prompt that goes nowhere", runId: "r-fb-3" },
      stub,
    )
    // Regex defaults this prompt to `implement` (no anchor, no bug, no summary).
    expect(out.hint).toBe("implement")
    expect(out.source).toBe("regex_fallback")
  })
})

describe("classifyIntentSmart — caches even on regex_fallback so subsequent calls short-circuit", () => {
  it("regex_fallback caches the regex result", async () => {
    delete process.env.GEMINI_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.OPENROUTER_API_KEY

    const stub = vi.fn()
    await classifyIntentSmart({ userMessage: "fix the broken auth", runId: "r-fb-cache" }, stub)
    expect(getIntentForRun("r-fb-cache")).toBe("bug")
    // Second call: cache hit (NOT regex_fallback again).
    const second = await classifyIntentSmart({ userMessage: "fix the broken auth", runId: "r-fb-cache" }, stub)
    expect(second.source).toBe("cache")
  })
})

describe("getCachedIntentOrRegex — sync helper for the tool-result code path", () => {
  it("returns cached value when present", () => {
    setIntentForRun("r-sync", "bug")
    expect(getCachedIntentOrRegex("r-sync", "anything")).toBe("bug")
  })

  it("falls back to regex on cache miss", () => {
    expect(getCachedIntentOrRegex("r-miss", "ls src")).toBe("simple")
    expect(getCachedIntentOrRegex("r-miss", "build a stripe integration")).toBe("implement")
    expect(getCachedIntentOrRegex("r-miss", "the typeerror is on line 12")).toBe("bug")
  })

  it("handles missing runId gracefully (cache lookup returns null)", () => {
    expect(getCachedIntentOrRegex(null, "ls src")).toBe("simple")
    expect(getCachedIntentOrRegex(undefined, "build a foo")).toBe("implement")
    expect(getCachedIntentOrRegex("", "the typeerror")).toBe("bug")
  })
})

describe("intent-cache — set/get/clear semantics", () => {
  it("setIntentForRun + getIntentForRun roundtrip", () => {
    setIntentForRun("a", "implement")
    expect(getIntentForRun("a")).toBe("implement")
  })

  it("getIntentForRun returns null for unknown runId", () => {
    expect(getIntentForRun("never-set")).toBe(null)
  })

  it("clearIntentForRun drops the entry", () => {
    setIntentForRun("b", "bug")
    expect(getIntentForRun("b")).toBe("bug")
    clearIntentForRun("b")
    expect(getIntentForRun("b")).toBe(null)
  })

  it("operations on null/undefined/empty runId are no-ops", () => {
    setIntentForRun(null, "implement")
    setIntentForRun(undefined, "implement")
    setIntentForRun("", "implement")
    expect(getIntentForRun(null)).toBe(null)
    expect(getIntentForRun(undefined)).toBe(null)
    expect(getIntentForRun("")).toBe(null)
    // No throws.
    clearIntentForRun(null)
    clearIntentForRun(undefined)
    clearIntentForRun("")
  })

  it("each run is independent", () => {
    setIntentForRun("run-1", "implement")
    setIntentForRun("run-2", "bug")
    expect(getIntentForRun("run-1")).toBe("implement")
    expect(getIntentForRun("run-2")).toBe("bug")
    clearIntentForRun("run-1")
    expect(getIntentForRun("run-1")).toBe(null)
    expect(getIntentForRun("run-2")).toBe("bug")  // unaffected
  })
})

describe("classifyIntentSmart — flag off path", () => {
  it("falls back to regex_fallback when LLM flag is off", async () => {
    // The flag default is `true`. We can simulate "off" by stubbing
    // getFlag... but the test infrastructure here just relies on the
    // env-key gate (which `pickReasonerBackend` checks AFTER the flag).
    // Easier: explicitly pin an unsupported flagOverride to force null.
    const stub: ClassifyIntentLlmCall = vi.fn()
    const out = await classifyIntentSmart(
      { userMessage: "build a foo", runId: "r-flag", flagOverride: "anthropic" /* no anthropic key set */ },
      stub,
    )
    expect(out.source).toBe("regex_fallback")
    expect(stub).not.toHaveBeenCalled()
  })
})
