import { describe, it, expect } from "vitest"
import { GeminiProvider } from "../gemini.js"

/**
 * Stage 1.5 of command-first-investigation: per-turn `reasoningChain` on
 * `NormalizedResponse`. Pins the extraction in `parseJsonResponse` —
 * model output → normalized envelope with the chain preserved.
 *
 * GeminiProvider used as a concrete instance since the parser lives on
 * BaseProvider and is identical across providers.
 */

const provider = new GeminiProvider()

function buildResponse(extra: Record<string, unknown>): string {
  return JSON.stringify({
    kind: "needs_tool",
    tool: "run_command",
    args: { command: "git status" },
    content: "Checking the repo state.",
    reasoning: "legacy single-line",
    ...extra,
  })
}

describe("parseJsonResponse — per-turn reasoningChain extraction (Stage 1.5)", () => {
  it("extracts reasoningChain when the model emits mid-to-long paragraphs", () => {
    const raw = buildResponse({
      reasoningChain: [
        "The user is asking me to investigate why the build is failing. The error message mentions a missing module — I should check git status first to see what's recently changed.",
        "Before I read any source files, running git status will tell me which files are modified, which is the most efficient way to narrow the suspect surface.",
      ],
    })
    const normalized = provider.parseJsonResponse(raw, "test-run")
    expect(normalized.reasoningChain).toHaveLength(2)
    expect(normalized.reasoningChain![0]).toContain("investigate why the build is failing")
  })

  it("omits reasoningChain when the field is absent (trivial-task short-circuit case)", () => {
    const raw = buildResponse({})
    const normalized = provider.parseJsonResponse(raw, "test-run")
    expect(normalized.reasoningChain).toBeUndefined()
  })

  it("filters non-string and empty entries defensively", () => {
    const raw = buildResponse({
      reasoningChain: ["valid paragraph", null, "", 42, "  ", "another valid paragraph"],
    })
    const normalized = provider.parseJsonResponse(raw, "test-run")
    expect(normalized.reasoningChain).toEqual(["valid paragraph", "another valid paragraph"])
  })

  it("caps at 6 entries — the model running away is a divergence signal, not a feature", () => {
    const raw = buildResponse({
      reasoningChain: Array.from({ length: 12 }, (_, i) => `paragraph ${i}`),
    })
    const normalized = provider.parseJsonResponse(raw, "test-run")
    expect(normalized.reasoningChain).toHaveLength(6)
    expect(normalized.reasoningChain![0]).toBe("paragraph 0")
    expect(normalized.reasoningChain![5]).toBe("paragraph 5")
  })

  it("preserves the legacy `reasoning` single-line field alongside the new chain", () => {
    const raw = buildResponse({
      reasoning: "legacy single-line summary",
      reasoningChain: ["a new-style paragraph reasoning step"],
    })
    const normalized = provider.parseJsonResponse(raw, "test-run")
    expect(normalized.reasoning).toBe("legacy single-line summary")
    expect(normalized.reasoningChain).toEqual(["a new-style paragraph reasoning step"])
  })

  it("does NOT set reasoningChain when the chain is non-array (malformed payload)", () => {
    const raw = buildResponse({ reasoningChain: "this is a string not an array" })
    const normalized = provider.parseJsonResponse(raw, "test-run")
    expect(normalized.reasoningChain).toBeUndefined()
  })

  it("does NOT set reasoningChain when array filters down to zero entries", () => {
    const raw = buildResponse({ reasoningChain: ["", null, 42] })
    const normalized = provider.parseJsonResponse(raw, "test-run")
    expect(normalized.reasoningChain).toBeUndefined()
  })
})
