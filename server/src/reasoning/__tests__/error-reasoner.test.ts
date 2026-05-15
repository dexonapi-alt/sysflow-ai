/**
 * Plan `2026-05-15-forced-error-reasoning-and-recovery.md` Stage 1+2.
 *
 * Tests for the iterative error-reasoning chain. The orchestrator
 * takes a `callBackend` DI parameter so tests inject canned
 * per-iteration JSON responses without touching `fetch` / SDK code.
 * Each test names the iteration sequence it's verifying.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  runErrorReasoningChain,
  parseErrorReasoningStep,
  buildErrorReasoningUserTurn,
  MAX_ERROR_REASONING_ITERATIONS,
  type ErrorReasoningPayload,
  type ErrorReasoningLlmCall,
  type ErrorReasoningStep,
} from "../error-reasoner.js"

const ORIGINAL_KEYS = {
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
}

beforeEach(() => {
  // Default a key so the chain runs. Tests that exercise no-backend
  // explicitly unset all three.
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

const basePayload: ErrorReasoningPayload = {
  errorText: "'ls' is not recognized as an internal or external command, operable program or batch file.",
  tool: "run_command",
  args: { command: "ls -R" },
  platform: "win32",
  model: "claude-sonnet",
}

/** Build a JSON-string iteration so test fixtures stay readable. */
function stepJson(step: Partial<ErrorReasoningStep> & { paragraph: string; done: boolean }): string {
  return JSON.stringify({
    paragraph: step.paragraph,
    done: step.done,
    rootCause: step.rootCause ?? null,
    platformContext: step.platformContext ?? null,
    alternatives: step.alternatives ?? [],
    recommendedCommand: step.recommendedCommand ?? null,
    confidence: step.confidence ?? null,
    supersedes: step.supersedes ?? null,
  })
}

describe("parseErrorReasoningStep — raw → typed", () => {
  it("parses a well-formed iteration", () => {
    const raw = stepJson({
      paragraph: "Windows cmd.exe doesn't have ls.",
      done: true,
      rootCause: "cmd.exe doesn't have ls as a built-in",
      platformContext: "win32 / cmd.exe",
      alternatives: ["dir /s", "Get-ChildItem -Recurse"],
      recommendedCommand: "dir /s",
      confidence: "HIGH",
    })
    const out = parseErrorReasoningStep(raw)
    expect(out).not.toBeNull()
    expect(out!.paragraph).toContain("cmd.exe")
    expect(out!.done).toBe(true)
    expect(out!.rootCause).toContain("cmd.exe")
    expect(out!.alternatives).toEqual(["dir /s", "Get-ChildItem -Recurse"])
    expect(out!.recommendedCommand).toBe("dir /s")
    expect(out!.confidence).toBe("HIGH")
  })

  it("strips ```json markdown fences before parsing", () => {
    const raw = "```json\n" + stepJson({ paragraph: "p", done: true, recommendedCommand: "Get-ChildItem", confidence: "HIGH" }) + "\n```"
    const out = parseErrorReasoningStep(raw)
    expect(out).not.toBeNull()
    expect(out!.recommendedCommand).toBe("Get-ChildItem")
  })

  it("returns null on invalid JSON", () => {
    expect(parseErrorReasoningStep("not json")).toBeNull()
    expect(parseErrorReasoningStep("{ unclosed")).toBeNull()
  })

  it("returns null when paragraph is empty (schema enforces min 1)", () => {
    const raw = stepJson({ paragraph: "", done: true, recommendedCommand: "dir", confidence: "HIGH" })
    expect(parseErrorReasoningStep(raw)).toBeNull()
  })

  it("returns null when confidence is out-of-enum", () => {
    const raw = JSON.stringify({
      paragraph: "x",
      done: true,
      rootCause: "x",
      platformContext: "x",
      alternatives: ["x"],
      recommendedCommand: "x",
      confidence: "VERY_HIGH",
      supersedes: null,
    })
    expect(parseErrorReasoningStep(raw)).toBeNull()
  })

  it("accepts done:false with null fields (chain not yet committed)", () => {
    const raw = stepJson({
      paragraph: "Could be a platform thing or a typo — need to check.",
      done: false,
      rootCause: null,
      platformContext: null,
      alternatives: [],
      recommendedCommand: null,
      confidence: null,
    })
    const out = parseErrorReasoningStep(raw)
    expect(out).not.toBeNull()
    expect(out!.done).toBe(false)
    expect(out!.recommendedCommand).toBeNull()
  })

  it("accepts supersedes as a non-negative integer", () => {
    const raw = stepJson({
      paragraph: "Revising prior pass — actually it's a permission issue.",
      done: true,
      rootCause: "permission denied",
      platformContext: "linux",
      alternatives: ["sudo chmod +x"],
      recommendedCommand: "chmod +x file",
      confidence: "HIGH",
      supersedes: 0,
    })
    const out = parseErrorReasoningStep(raw)
    expect(out!.supersedes).toBe(0)
  })

  it("caps alternatives at 6 entries per schema", () => {
    const raw = JSON.stringify({
      paragraph: "x",
      done: true,
      rootCause: "x",
      platformContext: "x",
      alternatives: ["a", "b", "c", "d", "e", "f", "g"],  // 7 — too many
      recommendedCommand: "a",
      confidence: "HIGH",
      supersedes: null,
    })
    expect(parseErrorReasoningStep(raw)).toBeNull()
  })
})

describe("buildErrorReasoningUserTurn — content shape", () => {
  it("first iteration: includes tool / args / platform / error verbatim", () => {
    const out = buildErrorReasoningUserTurn(basePayload, [], 0, MAX_ERROR_REASONING_ITERATIONS)
    expect(out).toContain("ITERATION 1 of up to 4")
    expect(out).toContain("TOOL: run_command")
    expect(out).toContain("ARGS:")
    expect(out).toContain("ls -R")
    expect(out).toContain("PLATFORM: win32")
    expect(out).toContain("ERROR (verbatim):")
    expect(out).toContain("'ls' is not recognized")
    expect(out).toContain("This is the FIRST iteration")
    expect(out).not.toContain("PRIOR PARAGRAPHS")
  })

  it("follow-up iteration: includes prior paragraphs with indices", () => {
    const priors = ["First pass: cmd.exe issue.", "Second pass: actually it's PowerShell aliasing."]
    const out = buildErrorReasoningUserTurn(basePayload, priors, 2, MAX_ERROR_REASONING_ITERATIONS)
    expect(out).toContain("ITERATION 3 of up to 4")
    expect(out).toContain("PRIOR PARAGRAPHS")
    expect(out).toContain("[0] First pass: cmd.exe issue.")
    expect(out).toContain("[1] Second pass: actually it's PowerShell aliasing.")
    expect(out).toContain("supersedes")
    expect(out).not.toContain("This is the FIRST iteration")
  })

  it("includes prior memory recall when present (Stage 5 hook)", () => {
    const out = buildErrorReasoningUserTurn(
      { ...basePayload, priorRecall: "Last time on win32 the agent used `Get-ChildItem -Recurse` and it worked." },
      [],
      0,
      MAX_ERROR_REASONING_ITERATIONS,
    )
    expect(out).toContain("PRIOR PATTERN MATCH")
    expect(out).toContain("Get-ChildItem -Recurse")
  })

  it("omits the PRIOR PATTERN MATCH block when no recall provided", () => {
    const out = buildErrorReasoningUserTurn(basePayload, [], 0, MAX_ERROR_REASONING_ITERATIONS)
    expect(out).not.toContain("PRIOR PATTERN MATCH")
  })

  it("truncates long error text so the prompt budget stays bounded", () => {
    const longError = "stack trace line\n".repeat(500)  // ~9000 chars
    const out = buildErrorReasoningUserTurn(
      { ...basePayload, errorText: longError },
      [],
      0,
      MAX_ERROR_REASONING_ITERATIONS,
    )
    // The error block is capped at 4000 chars in the implementation.
    const errorLineCount = (out.match(/stack trace line/g) || []).length
    expect(errorLineCount).toBeLessThan(500)  // some lines dropped
    expect(errorLineCount).toBeGreaterThan(100)  // most preserved
  })

  it("handles missing args gracefully (omits ARGS line)", () => {
    const out = buildErrorReasoningUserTurn(
      { ...basePayload, args: undefined },
      [],
      0,
      MAX_ERROR_REASONING_ITERATIONS,
    )
    expect(out).not.toContain("ARGS:")
    expect(out).toContain("TOOL: run_command")
  })

  it("always asks for JSON-only output (no markdown fences)", () => {
    const out = buildErrorReasoningUserTurn(basePayload, [], 0, MAX_ERROR_REASONING_ITERATIONS)
    expect(out).toContain("Output ONLY the JSON object")
    expect(out).toContain("No markdown fences")
  })
})

describe("runErrorReasoningChain — happy path (commit after 1 iteration)", () => {
  it("commits when iter 1 returns done:true HIGH", async () => {
    const stub: ErrorReasoningLlmCall = vi.fn().mockResolvedValueOnce(
      stepJson({
        paragraph: "Windows cmd.exe doesn't have ls. The error message 'is not recognized as an internal or external command' is the canonical cmd.exe error for unknown bins. Recommend dir /s as the cmd.exe-native equivalent.",
        done: true,
        rootCause: "cmd.exe doesn't have ls",
        platformContext: "win32 / cmd.exe",
        alternatives: ["dir /s", "Get-ChildItem -Recurse", "tree /F"],
        recommendedCommand: "dir /s",
        confidence: "HIGH",
      }),
    )

    const out = await runErrorReasoningChain(basePayload, stub)
    expect(out).not.toBeNull()
    expect(out!.rootCause).toContain("cmd.exe")
    expect(out!.platformContext).toContain("win32")
    expect(out!.alternativeCommands).toEqual(["dir /s", "Get-ChildItem -Recurse", "tree /F"])
    expect(out!.recommendedCommand).toBe("dir /s")
    expect(out!.confidence).toBe("HIGH")
    expect(out!.iterations).toBe(1)
    expect(out!.committedVia).toBe("done_flag")
    expect(out!.paragraphs).toHaveLength(1)
    expect(stub).toHaveBeenCalledTimes(1)
  })

  it("passes systemInstruction + userTurn to the backend call", async () => {
    const stub = vi.fn().mockResolvedValueOnce(
      stepJson({ paragraph: "p", done: true, recommendedCommand: "dir", confidence: "HIGH" }),
    )
    await runErrorReasoningChain(basePayload, stub)
    const call = stub.mock.calls[0][0]
    expect(call.systemInstruction).toContain("ERROR REASONING reasoner")
    expect(call.systemInstruction).toContain("SENIOR-ENGINEER ERROR-ANALYSIS RUBRIC")
    expect(call.userTurn).toContain("ls -R")
    expect(call.userTurn).toContain("win32")
  })
})

describe("runErrorReasoningChain — multi-iteration commit", () => {
  it("iterates twice when iter 1 raises a question (done:false)", async () => {
    const stub = vi.fn()
      .mockResolvedValueOnce(stepJson({
        paragraph: "Error 'permission denied' could be a missing chmod OR running as wrong user. Need to check which.",
        done: false,
        rootCause: null,
        platformContext: null,
        alternatives: [],
        recommendedCommand: null,
        confidence: null,
      }))
      .mockResolvedValueOnce(stepJson({
        paragraph: "Re-reading the error path — it's a project file the user owns. Most likely chmod, not user-mismatch.",
        done: true,
        rootCause: "missing execute permission",
        platformContext: "linux",
        alternatives: ["chmod +x script.sh", "sudo -u user script.sh"],
        recommendedCommand: "chmod +x script.sh",
        confidence: "MEDIUM",
      }))

    const out = await runErrorReasoningChain(
      { ...basePayload, errorText: "permission denied: ./script.sh", platform: "linux" },
      stub,
    )
    expect(out).not.toBeNull()
    expect(out!.recommendedCommand).toBe("chmod +x script.sh")
    expect(out!.confidence).toBe("MEDIUM")
    expect(out!.iterations).toBe(2)
    expect(out!.committedVia).toBe("done_flag")
    expect(out!.paragraphs).toHaveLength(2)
    expect(stub).toHaveBeenCalledTimes(2)
  })

  it("supersedes a prior paragraph instead of stacking", async () => {
    const stub = vi.fn()
      .mockResolvedValueOnce(stepJson({
        paragraph: "First read: looks like a network timeout (ETIMEDOUT).",
        done: false,
        rootCause: null,
        platformContext: null,
        alternatives: [],
        recommendedCommand: null,
        confidence: null,
      }))
      .mockResolvedValueOnce(stepJson({
        paragraph: "Re-reading more carefully — actually it's ECONNREFUSED, which means the service isn't running.",
        done: true,
        rootCause: "service not running",
        platformContext: "platform-independent",
        alternatives: ["docker-compose up -d postgres", "check port 5432"],
        recommendedCommand: "docker-compose up -d postgres",
        confidence: "HIGH",
        supersedes: 0,
      }))

    const out = await runErrorReasoningChain(basePayload, stub)
    expect(out).not.toBeNull()
    expect(out!.paragraphs).toHaveLength(1)
    expect(out!.paragraphs[0]).toContain("ECONNREFUSED")
    expect(out!.paragraphs[0]).not.toContain("ETIMEDOUT")
  })

  it("threads prior paragraphs into the next iteration's user turn", async () => {
    const stub = vi.fn()
      .mockResolvedValueOnce(stepJson({
        paragraph: "First reasoning.",
        done: false,
        rootCause: null,
        platformContext: null,
        alternatives: [],
        recommendedCommand: null,
        confidence: null,
      }))
      .mockResolvedValueOnce(stepJson({
        paragraph: "Second reasoning.",
        done: true,
        rootCause: "x",
        platformContext: "x",
        alternatives: ["a"],
        recommendedCommand: "a",
        confidence: "HIGH",
      }))

    await runErrorReasoningChain(basePayload, stub)
    const secondCall = stub.mock.calls[1][0]
    expect(secondCall.userTurn).toContain("PRIOR PARAGRAPHS")
    expect(secondCall.userTurn).toContain("[0] First reasoning.")
  })
})

describe("runErrorReasoningChain — step cap (LLM never commits)", () => {
  it("hits the cap and returns committedVia: step_cap WITH a recommendation", async () => {
    const stub = vi.fn().mockResolvedValue(
      stepJson({
        paragraph: "Still thinking — could be A or B.",
        done: false,
        rootCause: "indeterminate",
        platformContext: "win32",
        alternatives: ["try A", "try B"],
        recommendedCommand: "try A",  // partial commit on every iter
        confidence: "LOW",
      }),
    )

    const out = await runErrorReasoningChain(basePayload, stub)
    expect(out).not.toBeNull()
    expect(out!.iterations).toBe(MAX_ERROR_REASONING_ITERATIONS)
    expect(out!.committedVia).toBe("step_cap")
    expect(out!.recommendedCommand).toBe("try A")
    expect(out!.confidence).toBe("LOW")
    expect(stub).toHaveBeenCalledTimes(MAX_ERROR_REASONING_ITERATIONS)
  })

  it("honours an overridden maxIterations (testing knob)", async () => {
    const stub = vi.fn().mockResolvedValue(
      stepJson({
        paragraph: "still thinking",
        done: false,
        rootCause: "x",
        platformContext: "x",
        alternatives: ["a"],
        recommendedCommand: "a",
        confidence: "LOW",
      }),
    )

    const out = await runErrorReasoningChain(
      { ...basePayload, maxIterations: 2 },
      stub,
    )
    expect(out!.iterations).toBe(2)
    expect(out!.committedVia).toBe("step_cap")
    expect(stub).toHaveBeenCalledTimes(2)
  })

  it("returns null when chain never produced a recommendedCommand", async () => {
    const stub = vi.fn().mockResolvedValue(
      stepJson({
        paragraph: "still unsure",
        done: false,
        rootCause: null,
        platformContext: null,
        alternatives: [],
        recommendedCommand: null,
        confidence: null,
      }),
    )

    const out = await runErrorReasoningChain({ ...basePayload, maxIterations: 2 }, stub)
    expect(out).toBeNull()
  })

  it("clamps overridden maxIterations to MAX_ERROR_REASONING_ITERATIONS", async () => {
    const stub = vi.fn().mockResolvedValue(
      stepJson({
        paragraph: "still thinking",
        done: false,
        rootCause: "x",
        platformContext: "x",
        alternatives: ["a"],
        recommendedCommand: "a",
        confidence: "LOW",
      }),
    )

    const out = await runErrorReasoningChain(
      { ...basePayload, maxIterations: 100 },  // way above cap
      stub,
    )
    expect(out!.iterations).toBe(MAX_ERROR_REASONING_ITERATIONS)
    expect(stub).toHaveBeenCalledTimes(MAX_ERROR_REASONING_ITERATIONS)
  })
})

describe("runErrorReasoningChain — graceful degradation", () => {
  it("returns null when no reasoner backend is available", async () => {
    delete process.env.GEMINI_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.OPENROUTER_API_KEY

    const stub = vi.fn()
    const out = await runErrorReasoningChain(basePayload, stub)
    expect(out).toBeNull()
    expect(stub).not.toHaveBeenCalled()
  })

  it("stops the chain when an iteration throws (network failure)", async () => {
    const stub = vi.fn()
      .mockResolvedValueOnce(stepJson({
        paragraph: "First reasoning.",
        done: false,
        rootCause: "x",
        platformContext: "x",
        alternatives: ["a"],
        recommendedCommand: "a",
        confidence: "MEDIUM",
      }))
      .mockRejectedValueOnce(new Error("backend HTTP 429"))

    const out = await runErrorReasoningChain(basePayload, stub)
    // Still committed with iter-1's recommendation, degraded shape.
    expect(out).not.toBeNull()
    expect(out!.recommendedCommand).toBe("a")
    expect(out!.committedVia).toBe("step_cap")
    expect(out!.paragraphs).toHaveLength(1)
  })

  it("stops the chain when an iteration is unparseable", async () => {
    const stub = vi.fn()
      .mockResolvedValueOnce(stepJson({
        paragraph: "First reasoning.",
        done: false,
        rootCause: "x",
        platformContext: "x",
        alternatives: ["a"],
        recommendedCommand: "a",
        confidence: "HIGH",
      }))
      .mockResolvedValueOnce("not valid json")

    const out = await runErrorReasoningChain(basePayload, stub)
    expect(out).not.toBeNull()
    expect(out!.recommendedCommand).toBe("a")
  })

  it("returns null when iter 1 is unparseable (no prior recommendation)", async () => {
    const stub = vi.fn().mockResolvedValueOnce("malformed")
    const out = await runErrorReasoningChain(basePayload, stub)
    expect(out).toBeNull()
  })

  it("respects an explicit flagOverride (when key matches)", async () => {
    process.env.ANTHROPIC_API_KEY = "anthropic-key"
    const stub = vi.fn().mockResolvedValueOnce(
      stepJson({ paragraph: "p", done: true, recommendedCommand: "dir", confidence: "HIGH" }),
    )

    await runErrorReasoningChain({ ...basePayload, flagOverride: "anthropic" }, stub)
    expect(stub).toHaveBeenCalledTimes(1)
    expect(stub.mock.calls[0][0].backend).toBe("anthropic")
  })

  it("returns null when flagOverride pins to a backend with no API key", async () => {
    const stub = vi.fn()
    const out = await runErrorReasoningChain({ ...basePayload, flagOverride: "anthropic" }, stub)
    expect(out).toBeNull()
    expect(stub).not.toHaveBeenCalled()
  })
})
