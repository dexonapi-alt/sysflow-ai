/**
 * Plan `2026-05-16-reasoning-chain-provider-parity.md` Stage 3.
 *
 * Audit guarantee: the synthetic-response overrides in `base-provider.ts`
 * preserve the model's `reasoningChain` when they fire. Two overrides
 * cover the failure modes we audited:
 *
 *   1. `validateCompletionResponse` weak-completion override —
 *      swaps a thin `completed` response for a `needs_tool` that
 *      forces continuation. Used to drop the chain.
 *   2. `parseJsonResponse` tool-gate override — when the model
 *      emitted an unknown tool, the parser replaces the response
 *      with a list_directory + rejection-content envelope. Used to
 *      drop the chain.
 *
 * Without preservation, the cli's `<ReasoningPeek>` loses the model's
 * deliberation for that turn — Stage 1's normaliser fallback would
 * synthesise from `reasoning` (singular), but the override here had
 * already replaced `reasoning` with the override's own hardcoded
 * string. The model's actual thinking would be invisible.
 *
 * These tests pin the contract: when the model emitted a chain, the
 * overridden response carries it forward.
 */

import { describe, it, expect, beforeEach } from "vitest"
import { GeminiProvider } from "../gemini.js"
import type { NormalizedResponse } from "../../types.js"

// We instantiate any concrete provider — both overrides live on the
// base-provider abstract class so the choice doesn't matter for these
// tests. Gemini is convenient because it has the smallest constructor.

describe("base-provider override preservation — Stage 3 audit", () => {
  let provider: GeminiProvider

  beforeEach(() => {
    // Set a fake key so the constructor doesn't throw on env check.
    process.env.GEMINI_API_KEY = "test-key"
    provider = new GeminiProvider()
  })

  describe("validateCompletionResponse weak-completion override", () => {
    // The override fires when filesWritten === 0 + toolCalls <= 3 (or
    // similar weak markers) AND the response.kind === "completed".
    // The override returns a `needs_tool` that forces continuation.

    function callOverride(runId: string, normalized: NormalizedResponse): NormalizedResponse {
      // Cast to bypass protected access — test-only escape hatch.
      return (provider as unknown as { validateCompletionResponse(r: string, n: NormalizedResponse): NormalizedResponse })
        .validateCompletionResponse(runId, normalized)
    }

    it("preserves reasoningChain through the weak-completion override", () => {
      const runId = "test-weak-completion-1"
      // Default state: 0 files, 0 tools — meets the weak threshold.
      const incoming: NormalizedResponse = {
        kind: "completed",
        content: "done",
        reasoningChain: [
          "I think the scaffold is complete because index.ts exists.",
          "Skipping the route handlers since the user can add them later.",
        ],
        usage: { inputTokens: 0, outputTokens: 0 },
      }
      const out = callOverride(runId, incoming)
      expect(out.kind).toBe("needs_tool")
      expect(out.reasoningChain).toEqual([
        "I think the scaffold is complete because index.ts exists.",
        "Skipping the route handlers since the user can add them later.",
      ])
    })

    it("passes through reasoningChain as undefined when the model didn't emit one", () => {
      const runId = "test-weak-completion-2"
      const incoming: NormalizedResponse = {
        kind: "completed",
        content: "done",
        usage: { inputTokens: 0, outputTokens: 0 },
      }
      const out = callOverride(runId, incoming)
      expect(out.kind).toBe("needs_tool")
      expect(out.reasoningChain).toBeUndefined()
    })

    it("passes the response through unchanged when not a weak completion", () => {
      const runId = "test-weak-completion-3"
      // Simulate substantial work: many files + tools.
      ;(provider as unknown as { runFileCount: Map<string, number> }).runFileCount.set(runId, 10)
      ;(provider as unknown as { runToolCount: Map<string, number> }).runToolCount.set(runId, 15)
      const incoming: NormalizedResponse = {
        kind: "completed",
        content: "Built the full Express POS backend with auth, products, customers, orders. " +
                 "Wrote 10 files including routes, middleware, db config, and migrations. " +
                 "Run `npm install` then `npm run dev` to start.",
        reasoningChain: ["wrap-up paragraph"],
        usage: { inputTokens: 0, outputTokens: 0 },
      }
      const out = callOverride(runId, incoming)
      // Substantial completion — should pass through. May get
      // appended Next Steps but kind stays completed.
      expect(out.kind).toBe("completed")
      expect(out.reasoningChain).toEqual(["wrap-up paragraph"])
    })
  })

  describe("parseJsonResponse tool-gate override (unknown tool rejection)", () => {
    function callParse(text: string, runId?: string): NormalizedResponse {
      return provider.parseJsonResponse(text, runId)
    }

    it("preserves reasoningChain when the tool gate rejects an unknown tool", () => {
      const raw = JSON.stringify({
        kind: "needs_tool",
        tool: "definitely_not_a_real_tool",
        args: { foo: "bar" },
        reasoningChain: [
          "I think I need to call my custom tool to verify the auth flow.",
          "If that doesn't exist, I should fall back to read_file on the auth source.",
        ],
      })
      const out = callParse(raw, "test-tool-gate-1")
      expect(out.kind).toBe("needs_tool")
      // The override forces list_directory; tool name should be sanitised.
      expect(out.tool).toBe("list_directory")
      // The model's deliberation is preserved so the user sees WHY
      // the model picked the wrong tool.
      expect(out.reasoningChain).toEqual([
        "I think I need to call my custom tool to verify the auth flow.",
        "If that doesn't exist, I should fall back to read_file on the auth source.",
      ])
    })

    it("preserves reasoningChain through the tools-array variant of the override", () => {
      const raw = JSON.stringify({
        kind: "needs_tool",
        tools: [
          { id: "t1", tool: "made_up_tool_one", args: {} },
          { id: "t2", tool: "made_up_tool_two", args: {} },
        ],
        reasoningChain: ["I wanted to do two custom things in parallel."],
      })
      const out = callParse(raw, "test-tool-gate-2")
      expect(out.kind).toBe("needs_tool")
      expect(out.tool).toBe("list_directory")
      expect(out.reasoningChain).toEqual(["I wanted to do two custom things in parallel."])
    })

    it("passes reasoningChain undefined when the model didn't emit one alongside the bad tool", () => {
      const raw = JSON.stringify({
        kind: "needs_tool",
        tool: "fake_tool",
        args: {},
      })
      const out = callParse(raw, "test-tool-gate-3")
      expect(out.kind).toBe("needs_tool")
      expect(out.tool).toBe("list_directory")
      expect(out.reasoningChain).toBeUndefined()
    })
  })
})
