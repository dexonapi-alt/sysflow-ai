/**
 * Anthropic Claude Haiku reasoner backend.
 *
 * Chosen so paid claude-sonnet / claude-opus runs can use a same-vendor
 * reasoner instead of forcing the user to keep a working Gemini key.
 * Haiku 4.5 is currently the cheapest Anthropic reasoning-capable model
 * (~$0.80/M input tokens — roughly parity with Gemini Flash).
 *
 * Transport: direct `/v1/messages` POST. Mirrors the main Anthropic
 * provider's auth + content extraction. No SDK dependency.
 *
 * JSON envelope: Anthropic doesn't have a JSON-only response mode like
 * Gemini's `responseMimeType: "application/json"`, so the system
 * instruction must include the "Output ONLY the JSON envelope" rubric
 * (already part of `getPipelineSystemPrompt(kind)`). We also pass a
 * short `Output ONLY the JSON envelope. Nothing else.` reminder as a
 * suffix to the user turn — same trick `buildUserTurn` uses in
 * `task-reasoner.ts`.
 */

import type { BackendCallArgs } from "./index.js"

const API_URL = "https://api.anthropic.com/v1/messages"
const ANTHROPIC_API_VERSION = "2023-06-01"
const REASONER_MODEL = "claude-haiku-4-5"
const FETCH_TIMEOUT_MS = 30_000

export async function callAnthropicBackend(args: BackendCallArgs): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set")

  const userTurn = args.userTurnOverride ?? args.defaultUserTurn

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_API_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: REASONER_MODEL,
        system: args.systemInstruction,
        messages: [{ role: "user", content: userTurn }],
        max_tokens: args.maxOutputTokens,
        temperature: 0.0,
      }),
      signal: controller.signal,
    })

    if (!response.ok) {
      const body = await response.text().catch(() => "(no body)")
      // Throw so the caller's existing retry/timeout machinery treats
      // it as a hard failure (matches the Gemini SDK's throw-on-error
      // contract).
      throw new Error(`Anthropic reasoner HTTP ${response.status}: ${body.slice(0, 200)}`)
    }

    const data = await response.json() as {
      content?: Array<{ type?: string; text?: string }>
    }

    // Anthropic returns an array of content blocks. For text-only
    // responses (which is what JSON-envelope prompts produce) the first
    // block holds the answer. Concatenate defensively.
    const text = (data.content ?? [])
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("")

    if (!text) {
      throw new Error("Anthropic reasoner returned empty content")
    }
    return text
  } finally {
    clearTimeout(timer)
  }
}
