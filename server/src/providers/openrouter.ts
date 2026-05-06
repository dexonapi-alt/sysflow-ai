import { BaseProvider } from "./base-provider.js"
import type { ProviderPayload, NormalizedResponse, TokenUsage } from "../types.js"

interface ChatMessage {
  role: "system" | "user" | "assistant"
  content: string
}

const API_URL = "https://openrouter.ai/api/v1/chat/completions"

export class OpenRouterProvider extends BaseProvider {
  readonly name = "OpenRouter"

  readonly modelMap: Record<string, string> = {
    "openrouter-auto": "openrouter/auto",
    "llama-70b": "meta-llama/llama-3.3-70b-instruct:free",
    "mistral-small": "mistralai/mistral-small-3.1-24b-instruct:free",
    "gemini-flash-or": "google/gemini-2.0-flash-exp:free"
  }

  private getApiKey(): string {
    const key = process.env.OPENROUTER_API_KEY
    if (!key) throw new Error("OPENROUTER_API_KEY is not set in .env")
    return key
  }

  async call(payload: ProviderPayload): Promise<NormalizedResponse> {
    const apiKey = this.getApiKey()
    const modelName = this.getModelName(payload.model)

    try {
      let history = this.runState.get(payload.runId) as ChatMessage[] | undefined

      if (!payload.toolResult && !payload.toolResults) {
        // First call — new conversation
        history = [
          { role: "system", content: this.systemPrompt },
          { role: "user", content: this.buildInitialUserMessage(payload) }
        ]
        this.runState.set(payload.runId, history)
        this.setRunTask(payload.runId, payload.userMessage)
      } else {
        // Continuation — add tool result(s) to history
        // Ensure runTask is set even for error-aware flows that skip the initial model call
        if (!this.runTasks.has(payload.runId) && payload.userMessage) {
          this.setRunTask(payload.runId, payload.userMessage)
        }
        const toolMsg = this.buildToolResultMessage(payload)

        if (!history) {
          history = [
            { role: "system", content: this.systemPrompt },
            { role: "user", content: `Previous ${toolMsg}` }
          ]
          this.runState.set(payload.runId, history)
        } else {
          history.push({ role: "user", content: toolMsg })
        }
      }

      const MAX_RETRIES = 2
      let response: Response | undefined
      let lastError: Error | undefined
      // Default headroom stays — the right way to spend less is to make the
      // AGENT chunk work across turns (see task-guidelines.ts CHUNKING),
      // not to cap responses preemptively. The 402 affordability retry below
      // is a safety net for accounts that genuinely can't afford the request.
      let maxTokensCap = this.getAdaptiveMaxTokens(32768)

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          const controller = new AbortController()
          const timeout = setTimeout(() => controller.abort(), 120_000)

          response = await fetch(API_URL, {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${apiKey}`,
              "Content-Type": "application/json",
              "HTTP-Referer": "https://sysflow.dev",
              "X-Title": "Sysflow Agent"
            },
            body: JSON.stringify({
              model: modelName,
              messages: history,
              response_format: { type: "json_object" },
              temperature: 0.1,
              max_tokens: maxTokensCap
            }),
            signal: controller.signal
          })

          clearTimeout(timeout)

          // 402 = "you can only afford N tokens" on free OpenRouter accounts.
          // Parse the affordable number out of the error and retry once with
          // a 90% safety margin below it. Avoids the user seeing a confusing
          // "402 — upgrade for more credits" abort when they're working
          // through a small agent turn that doesn't actually need 16k+.
          if (response.status === 402 && attempt < MAX_RETRIES) {
            const errBody = await response.clone().text()
            const affordable = parseAffordableTokens(errBody)
            if (affordable && affordable > 512) {
              const next = Math.floor(affordable * 0.9)
              console.warn(`[openrouter] 402 affordability — lowering max_tokens ${maxTokensCap} → ${next} and retrying`)
              maxTokensCap = next
              continue
            }
          }
          break
        } catch (fetchErr) {
          lastError = fetchErr as Error
          console.error(`[openrouter] Fetch attempt ${attempt + 1} failed:`, lastError.message)
          if (attempt < MAX_RETRIES) {
            await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)))
          }
        }
      }

      if (!response) {
        throw lastError || new Error("OpenRouter fetch failed after retries")
      }

      if (!response.ok) {
        const errBody = await response.text()
        const status = response.status
        console.error(`[openrouter] HTTP ${status}:`, errBody)

        // Rate limit — DON'T clear run state, signal for retry/fallback
        if (status === 429) {
          return this.rateLimitedResponse(`OpenRouter rate limit (429). Details: ${errBody.slice(0, 200)}`)
        }

        this.clearRunState(payload.runId)

        if (status === 401 || status === 403) {
          return this.failedResponse(`OpenRouter auth error (${status}). Check your OPENROUTER_API_KEY.`)
        }
        if (status === 402) {
          return this.failedResponse(
            `OpenRouter is out of credits and even the lowest affordable max_tokens would be too small to be useful. ` +
            `Top up at https://openrouter.ai/settings/credits, switch model with /model gemini-flash, ` +
            `or set GEMINI_API_KEY in server/.env (free tier from Google AI Studio). Original error: ${errBody.slice(0, 200)}`
          )
        }
        return this.failedResponse(`OpenRouter error ${status}: ${errBody.slice(0, 300)}`)
      }

      const data = await response.json() as {
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_cost?: number }
        choices?: Array<{ message?: { content?: string } }>
      }

      const usage: TokenUsage = {
        inputTokens: data.usage?.prompt_tokens || 0,
        outputTokens: data.usage?.completion_tokens || 0,
        generationData: data.usage?.total_cost != null ? { total_cost: data.usage.total_cost } : null
      }

      const assistantMessage = data.choices?.[0]?.message?.content || ""

      // Add assistant response to history for multi-turn
      history!.push({ role: "assistant", content: assistantMessage })

      let normalized = this.parseJsonResponse(assistantMessage, payload.runId)
      normalized.usage = usage
      this.onSuccessfulCall()

      // Layer 2: provider-level completion validation
      normalized = this.validateCompletionResponse(payload.runId, normalized)

      if (normalized.kind === "completed" || normalized.kind === "failed") {
        this.clearRunState(payload.runId)
      }

      return normalized
    } catch (err) {
      this.clearRunState(payload.runId)

      const errMsg = (err as Error).message || ""
      console.error("[openrouter] Error:", errMsg)

      if (errMsg.includes("OPENROUTER_API_KEY")) {
        return this.failedResponse("OPENROUTER_API_KEY is not set in .env")
      }

      return this.failedResponse(`OpenRouter error: ${errMsg}`)
    }
  }
}

/**
 * Pull the affordability number out of an OpenRouter 402 body, e.g.:
 *   "You requested up to 32768 tokens, but can only afford 15018."
 * Returns null when the body doesn't carry one. Exported for tests.
 */
export function parseAffordableTokens(errBody: string): number | null {
  if (!errBody) return null
  const m = errBody.match(/can only afford\s+(\d+)/i)
  if (!m) return null
  const n = parseInt(m[1], 10)
  return Number.isFinite(n) && n > 0 ? n : null
}
