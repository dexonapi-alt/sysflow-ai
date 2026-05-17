/**
 * Plan `2026-05-16-server-hardening-and-error-source-distinction.md` Stage 2.
 *
 * Tests for the `errorSource` discriminator propagation through:
 *   - `failedResponse()` on base-provider (default param)
 *   - `mapNormalizedResponseToClient` (failed envelope wiring)
 * Plus per-provider tagging of known sysflow_infra failure paths.
 */

import { describe, it, expect, beforeEach } from "vitest"
import { mapNormalizedResponseToClient } from "../normalize.js"
import { GeminiProvider } from "../gemini.js"
import type { NormalizedResponse } from "../../types.js"

describe("base-provider.failedResponse — errorSource parameter", () => {
  let provider: GeminiProvider

  beforeEach(() => {
    process.env.GEMINI_API_KEY = "test-key"
    provider = new GeminiProvider()
  })

  it("defaults errorSource to 'unknown' (legacy callers)", () => {
    const r = provider.failedResponse("something went wrong")
    expect(r.errorSource).toBe("unknown")
    expect(r.kind).toBe("failed")
  })

  it("propagates 'sysflow_infra' when passed", () => {
    const r = provider.failedResponse("OpenRouter out of credits", "sysflow_infra")
    expect(r.errorSource).toBe("sysflow_infra")
  })

  it("propagates 'user_machine' when passed", () => {
    const r = provider.failedResponse("file not found", "user_machine")
    expect(r.errorSource).toBe("user_machine")
  })

  it("includes usage block (no token cost on failure)", () => {
    const r = provider.failedResponse("x", "sysflow_infra")
    expect(r.usage).toEqual({ inputTokens: 0, outputTokens: 0 })
  })
})

describe("mapNormalizedResponseToClient — errorSource on failed envelope", () => {
  it("propagates errorSource='sysflow_infra' to client", () => {
    const out = mapNormalizedResponseToClient("r1", {
      kind: "failed",
      error: "OpenRouter 402",
      errorSource: "sysflow_infra",
      usage: { inputTokens: 0, outputTokens: 0 },
    } as unknown as NormalizedResponse)
    expect(out.status).toBe("failed")
    expect(out.errorSource).toBe("sysflow_infra")
  })

  it("propagates errorSource='user_machine' to client", () => {
    const out = mapNormalizedResponseToClient("r2", {
      kind: "failed",
      error: "file not found",
      errorSource: "user_machine",
      usage: { inputTokens: 0, outputTokens: 0 },
    } as unknown as NormalizedResponse)
    expect(out.errorSource).toBe("user_machine")
  })

  it("defaults errorSource to 'unknown' when absent on the normalized envelope", () => {
    const out = mapNormalizedResponseToClient("r3", {
      kind: "failed",
      error: "legacy error path",
      usage: { inputTokens: 0, outputTokens: 0 },
    } as unknown as NormalizedResponse)
    expect(out.errorSource).toBe("unknown")
  })

  it("does not attach errorSource on non-failed envelopes", () => {
    const out = mapNormalizedResponseToClient("r4", {
      kind: "needs_tool",
      tool: "read_file",
      args: { path: "x" },
      usage: { inputTokens: 0, outputTokens: 0 },
    } as unknown as NormalizedResponse)
    expect(out.errorSource).toBeUndefined()
  })
})
