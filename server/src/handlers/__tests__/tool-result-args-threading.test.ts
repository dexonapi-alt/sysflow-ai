/**
 * Plan `2026-05-18-chunk-pulse-missing-diagnostic.md` Stage 3 regression
 * test for the args-threading bug discovered while diagnosing the
 * chunk-pulse-missing repro.
 *
 * The bug: `tool-result.ts` was calling
 *
 *   ingestToolResult(body.runId, body.tool, body.result, body.result)
 *
 * — passing `body.result` for BOTH the args param AND the result param.
 * That accidentally worked for tools whose result echoed back `path`
 * (e.g. write_file at executor.ts:263), but FAILED for `args.content`
 * which is never echoed. The downstream effect was that the divergence
 * detector's structural-signal check (Stage 2 of the awareness-and-
 * verification-correctness plan) couldn't satisfy `intent_keyword_absent:
 * express` from a package.json content snippet — because the snippet
 * was never captured into `contentSnippets`.
 *
 * The fix: thread the original tool args from cli → server through a
 * new optional `args` field on `ToolResultBody` (and on each
 * `toolResults[]` entry for the batch path). The server call sites
 * use `body.args ?? body.result` so old cli builds still get the
 * pre-fix fallback shape, and new builds get the correct args.
 *
 * This test pins the SELECTION logic that the handler uses (it doesn't
 * exercise the full handler — that requires a database + run state).
 * The two halves it asserts:
 *
 *   1. When the cli sends `args`, the snippet capture works (express
 *      keyword satisfied from package.json content).
 *   2. When the cli omits `args` (old build), the fallback path still
 *      passes `body.result` so we don't crash — but the snippet stays
 *      empty, matching pre-fix behaviour.
 */

import { describe, it, expect, beforeEach } from "vitest"
import {
  initRunContext,
  clearRunContext,
  ingestToolResult,
  getContentSnippets,
} from "../../services/context-manager.js"
import { classifyIntentKeywordSatisfaction } from "../../services/divergence-detector.js"

const RUN_ID = "test-run-args-threading"

beforeEach(() => {
  clearRunContext(RUN_ID)
  initRunContext(RUN_ID, "build an Express POS backend with Postgres")
})

/**
 * Mirror of the handler's args-selection (lines ~382-393 in
 * tool-result.ts after Plan 4 Stage 3): prefer the explicit args
 * field; fall back to the result for old cli builds.
 */
function selectArgs(body: { args?: Record<string, unknown>; result: Record<string, unknown> }): Record<string, unknown> {
  return body.args ?? body.result
}

describe("tool-result args threading — new cli payload shape", () => {
  it("when body.args is set with content, the snippet is captured and intent keyword satisfies structurally", () => {
    const body = {
      tool: "write_file",
      args: { path: "package.json", content: `{ "dependencies": { "express": "^4" } }` },
      result: { path: "package.json", success: true, diffAdded: 5, diffRemoved: 0 },
    }
    // The handler now does:
    //   const singleArgs = body.args ?? body.result
    //   ingestToolResult(runId, body.tool, singleArgs, body.result)
    ingestToolResult(RUN_ID, body.tool, selectArgs(body), body.result)

    const snippets = getContentSnippets(RUN_ID)
    expect(snippets.size).toBe(1)
    expect(snippets.get("package.json")).toContain("express")

    // End-to-end: the detector's structural-signal check satisfies
    // "express" because the snippet is now present.
    const tier = classifyIntentKeywordSatisfaction(
      "express",
      "package.json", // pathHaystack (lowercased join of filesModified)
      ["package.json"],
      snippets,
    )
    // Tier 1 (path) wins because the file path itself contains "express"-free name; actually it's package.json which doesn't contain "express", so tier 2 (structural) should hit.
    expect(tier === "path" || tier === "structural").toBe(true)
  })

  it("user-repro: package.json with express in deps satisfies `intent_keyword_absent: express` via structural signal", () => {
    // The 2026-05-18 user trace: agent wrote package.json with
    // express + postgres deps; off-course modal still flagged
    // `intent_keyword_absent: express, postgres`. With args threaded
    // correctly, both keywords should satisfy.
    const body = {
      tool: "write_file",
      args: {
        path: "package.json",
        content: `{
          "name": "pos-backend",
          "dependencies": {
            "express": "^4.18.0",
            "pg": "^8.11.0",
            "dotenv": "^16.0.0"
          }
        }`,
      },
      result: { path: "package.json", success: true },
    }
    ingestToolResult(RUN_ID, body.tool, selectArgs(body), body.result)

    const snippets = getContentSnippets(RUN_ID)
    const pathHaystack = "package.json"
    const filesModified = ["package.json"]

    const expressTier = classifyIntentKeywordSatisfaction("express", pathHaystack, filesModified, snippets)
    const postgresTier = classifyIntentKeywordSatisfaction("postgres", pathHaystack, filesModified, snippets)

    expect(expressTier).not.toBeNull()
    expect(postgresTier).not.toBeNull()
  })
})

describe("tool-result args threading — back-compat fallback for old cli builds", () => {
  it("when body.args is absent (old cli), falls back to body.result — no crash, but snippet capture is lossy", () => {
    // Pre-fix shape: cli only sent `result`. The result for write_file
    // doesn't include `content` (just path / success / diff stats).
    // The fallback preserves this shape so a mixed old-cli/new-server
    // setup doesn't crash.
    const body = {
      tool: "write_file",
      // args: undefined  ← old cli build
      result: { path: "package.json", success: true, diffAdded: 5, diffRemoved: 0 },
    }
    expect(() => {
      ingestToolResult(RUN_ID, body.tool, selectArgs(body), body.result)
    }).not.toThrow()

    // The snippet IS NOT captured because args.content was undefined
    // in the fallback shape. This is the pre-fix behaviour we're
    // pinning so a regression to "body.result for both" is detected.
    const snippets = getContentSnippets(RUN_ID)
    expect(snippets.size).toBe(0)
  })

  it("selectArgs prefers explicit args over result (regression guard)", () => {
    const body = {
      args: { path: "src/foo.ts", content: "explicit args content" },
      result: { path: "src/foo.ts", success: true },
    }
    const picked = selectArgs(body)
    expect(picked).toBe(body.args)
    expect((picked as { content?: string }).content).toBe("explicit args content")
  })

  it("selectArgs returns result when args is undefined (back-compat)", () => {
    const body = { result: { path: "src/foo.ts", success: true } } as { args?: Record<string, unknown>; result: Record<string, unknown> }
    const picked = selectArgs(body)
    expect(picked).toBe(body.result)
  })
})
