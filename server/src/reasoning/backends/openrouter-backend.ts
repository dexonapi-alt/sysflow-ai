/**
 * OpenRouter reasoner backend.
 *
 * Used when the main model is OpenRouter-routed (openrouter-auto,
 * llama variants, mistral variants, gemini-flash-or) AND no
 * GEMINI_API_KEY is set on the host. Routes through a free Gemini
 * Flash variant by default (`google/gemini-2.0-flash-exp:free`) so the
 * reasoning behaviour stays comparable to the direct-Gemini path
 * without the user needing a Gemini key.
 *
 * Transport: OpenAI-compatible chat completions endpoint. JSON mode is
 * supported via `response_format: { type: "json_object" }` on Google +
 * Mistral routes; other free routes silently ignore it, which is fine
 * because the system instruction already demands JSON output.
 */

import type { BackendCallArgs } from "./index.js"

const API_URL = "https://openrouter.ai/api/v1/chat/completions"
const REASONER_MODEL = "google/gemini-2.0-flash-exp:free"
const FETCH_TIMEOUT_MS = 30_000

export async function callOpenRouterBackend(args: BackendCallArgs): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set")

  const userTurn = args.userTurnOverride ?? args.defaultUserTurn

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        // OpenRouter best-practice attribution headers — same shape as
        // the main provider uses. Harmless if absent; helpful for
        // OpenRouter's analytics if the user ever needs to debug an
        // outage.
        "HTTP-Referer": "https://github.com/dexonapi-alt/sysflow-ai",
        "X-Title": "sysflow-ai",
      },
      body: JSON.stringify({
        model: REASONER_MODEL,
        messages: [
          { role: "system", content: args.systemInstruction },
          { role: "user", content: userTurn },
        ],
        max_tokens: args.maxOutputTokens,
        temperature: 0.0,
        response_format: { type: "json_object" },
      }),
      signal: controller.signal,
    })

    if (!response.ok) {
      const body = await response.text().catch(() => "(no body)")
      throw new Error(`OpenRouter reasoner HTTP ${response.status}: ${body.slice(0, 200)}`)
    }

    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>
    }
    const text = data.choices?.[0]?.message?.content ?? ""
    if (!text) {
      throw new Error("OpenRouter reasoner returned empty content")
    }
    return text
  } finally {
    clearTimeout(timer)
  }
}
