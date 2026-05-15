/**
 * Stage D of model-lock-and-portable-reasoning plan: backend transport
 * contract tests.
 *
 * Each backend exports `call(args) → Promise<string>`. Contract:
 *   - Throws when its API key is absent (so dispatcher can detect)
 *   - Returns the raw text content on a successful response
 *   - Throws on HTTP error so the caller's retry / timeout machinery
 *     treats it as a hard failure
 *   - Throws on empty content
 *
 * Gemini uses the official SDK so it's harder to mock at the fetch
 * layer; we cover its API-key check + tag behaviour at the routing /
 * dispatcher level. Anthropic and OpenRouter both use `fetch`, which
 * vitest stubs cleanly.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { callAnthropicBackend } from "../backends/anthropic-backend.js"
import { callOpenRouterBackend } from "../backends/openrouter-backend.js"
import { callGeminiBackend } from "../backends/gemini-backend.js"
import type { BackendCallArgs } from "../backends/index.js"
import type { ReasoningPayload } from "../task-reasoner.js"

const stubPayload: ReasoningPayload = {
  trigger: "preflight",
  userMessage: "build a thing",
  model: "claude-sonnet",
  cwd: null,
}

function baseArgs(): BackendCallArgs {
  return {
    payload: stubPayload,
    kind: "implement",
    userTurnOverride: undefined,
    defaultUserTurn: "PIPELINE: implement\nUSER PROMPT:\nbuild a thing",
    maxOutputTokens: 2_500,
    systemInstruction: "Output ONLY the JSON envelope.",
  }
}

describe("callAnthropicBackend — contract", () => {
  const originalKey = process.env.ANTHROPIC_API_KEY
  const originalFetch = global.fetch

  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY
  })

  afterEach(() => {
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = originalKey
    global.fetch = originalFetch
  })

  it("throws when ANTHROPIC_API_KEY is absent", async () => {
    await expect(callAnthropicBackend(baseArgs())).rejects.toThrow(/ANTHROPIC_API_KEY/)
  })

  it("returns the joined text content on success", async () => {
    process.env.ANTHROPIC_API_KEY = "test"
    const json = vi.fn().mockResolvedValue({
      content: [
        { type: "text", text: '{"kind"' },
        { type: "text", text: ':"implement"}' },
      ],
    })
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json } as unknown as Response) as typeof fetch

    const out = await callAnthropicBackend(baseArgs())
    expect(out).toBe('{"kind":"implement"}')
    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.anthropic.com/v1/messages",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "x-api-key": "test",
          "anthropic-version": "2023-06-01",
        }),
      }),
    )
  })

  it("throws on HTTP error", async () => {
    process.env.ANTHROPIC_API_KEY = "test"
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: vi.fn().mockResolvedValue("rate limited"),
    } as unknown as Response) as typeof fetch

    await expect(callAnthropicBackend(baseArgs())).rejects.toThrow(/HTTP 429/)
  })

  it("throws on empty content", async () => {
    process.env.ANTHROPIC_API_KEY = "test"
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ content: [] }),
    } as unknown as Response) as typeof fetch

    await expect(callAnthropicBackend(baseArgs())).rejects.toThrow(/empty content/)
  })

  it("filters non-text content blocks defensively", async () => {
    process.env.ANTHROPIC_API_KEY = "test"
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        content: [
          { type: "tool_use", id: "tu_1" },     // ignored
          { type: "text", text: "the answer" },
          { type: "text" },                      // missing text field — ignored
        ],
      }),
    } as unknown as Response) as typeof fetch

    const out = await callAnthropicBackend(baseArgs())
    expect(out).toBe("the answer")
  })

  it("uses userTurnOverride when supplied", async () => {
    process.env.ANTHROPIC_API_KEY = "test"
    let capturedBody = ""
    global.fetch = vi.fn().mockImplementation((_url, opts: RequestInit) => {
      capturedBody = opts.body as string
      return Promise.resolve({
        ok: true,
        json: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] }),
      } as unknown as Response)
    }) as typeof fetch

    await callAnthropicBackend({ ...baseArgs(), userTurnOverride: "CRITIQUE: …" })
    expect(capturedBody).toContain("CRITIQUE")
    expect(capturedBody).not.toContain("PIPELINE: implement")
  })
})

describe("callOpenRouterBackend — contract", () => {
  const originalKey = process.env.OPENROUTER_API_KEY
  const originalFetch = global.fetch

  beforeEach(() => {
    delete process.env.OPENROUTER_API_KEY
  })

  afterEach(() => {
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY
    else process.env.OPENROUTER_API_KEY = originalKey
    global.fetch = originalFetch
  })

  it("throws when OPENROUTER_API_KEY is absent", async () => {
    await expect(callOpenRouterBackend(baseArgs())).rejects.toThrow(/OPENROUTER_API_KEY/)
  })

  it("returns the assistant message content on success", async () => {
    process.env.OPENROUTER_API_KEY = "test"
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        choices: [{ message: { content: '{"kind":"implement"}' } }],
      }),
    } as unknown as Response) as typeof fetch

    const out = await callOpenRouterBackend(baseArgs())
    expect(out).toBe('{"kind":"implement"}')
  })

  it("hits the openrouter chat-completions endpoint with bearer auth", async () => {
    process.env.OPENROUTER_API_KEY = "test-key"
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ choices: [{ message: { content: "{}" } }] }),
    } as unknown as Response) as typeof fetch

    await callOpenRouterBackend(baseArgs())
    expect(global.fetch).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Authorization": "Bearer test-key",
        }),
      }),
    )
  })

  it("throws on HTTP error", async () => {
    process.env.OPENROUTER_API_KEY = "test"
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 402,
      text: vi.fn().mockResolvedValue("insufficient credits"),
    } as unknown as Response) as typeof fetch

    await expect(callOpenRouterBackend(baseArgs())).rejects.toThrow(/HTTP 402/)
  })

  it("throws on empty content", async () => {
    process.env.OPENROUTER_API_KEY = "test"
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ choices: [{ message: { content: "" } }] }),
    } as unknown as Response) as typeof fetch

    await expect(callOpenRouterBackend(baseArgs())).rejects.toThrow(/empty content/)
  })

  it("passes the system prompt as the first message", async () => {
    process.env.OPENROUTER_API_KEY = "test"
    let capturedBody: Record<string, unknown> = {}
    global.fetch = vi.fn().mockImplementation((_url, opts: RequestInit) => {
      capturedBody = JSON.parse(opts.body as string)
      return Promise.resolve({
        ok: true,
        json: vi.fn().mockResolvedValue({ choices: [{ message: { content: "ok" } }] }),
      } as unknown as Response)
    }) as typeof fetch

    await callOpenRouterBackend({ ...baseArgs(), systemInstruction: "you must output JSON" })
    const messages = capturedBody.messages as Array<{ role: string; content: string }>
    expect(messages[0]).toEqual({ role: "system", content: "you must output JSON" })
  })
})

describe("callGeminiBackend — API key check", () => {
  const originalKey = process.env.GEMINI_API_KEY

  beforeEach(() => {
    delete process.env.GEMINI_API_KEY
  })

  afterEach(() => {
    if (originalKey === undefined) delete process.env.GEMINI_API_KEY
    else process.env.GEMINI_API_KEY = originalKey
  })

  it("throws when GEMINI_API_KEY is absent", async () => {
    await expect(callGeminiBackend(baseArgs())).rejects.toThrow(/GEMINI_API_KEY/)
  })
})
