/**
 * AnthropicProvider — direct Anthropic API integration for Claude Sonnet
 * and Claude Opus.
 *
 * Replaces the day-one mock providers (`claude-sonnet.ts` / `claude-opus.ts`)
 * with a real implementation that calls Anthropic's `/v1/messages` endpoint.
 * Both Sonnet and Opus share the same API surface, so a single class with
 * two entries in `modelMap` handles both — the user-facing IDs
 * (`claude-sonnet` / `claude-opus`) match what `base-provider.ts`'s
 * fallback chains and `context-budget.ts` already reference.
 *
 * Mirrors the OpenRouter provider's pattern for run-state tracking,
 * retry-on-rate-limit, and JSON-envelope parsing — Anthropic doesn't have
 * native `response_format: json_object`, so we rely on the existing system
 * prompt instructing the model to output the envelope. Claude follows the
 * format reliably; the parser tolerates stray prose around it.
 */

import { BaseProvider } from "./base-provider.js"
import type { ProviderPayload, NormalizedResponse, TokenUsage } from "../types.js"

interface AnthropicMessage {
  role: "user" | "assistant"
  content: string
}

const API_URL = "https://api.anthropic.com/v1/messages"
const ANTHROPIC_API_VERSION = "2023-06-01"

export class AnthropicProvider extends BaseProvider {
  readonly name = "Anthropic"

  /**
   * Sysflow IDs → Anthropic model IDs. Update the right-hand side when
   * Anthropic releases new model versions; the left side is stable so
   * users' `/model claude-sonnet` selections don't break.
   */
  readonly modelMap: Record<string, string> = {
    "claude-sonnet": "claude-sonnet-4-5",
    "claude-opus":   "claude-opus-4-5",
  }

  private getApiKey(): string {
    const key = process.env.ANTHROPIC_API_KEY
    if (!key) throw new Error("ANTHROPIC_API_KEY is not set in .env")
    return key
  }

  async call(payload: ProviderPayload): Promise<NormalizedResponse> {
    const apiKey = this.getApiKey()
    const modelName = this.getModelName(payload.model)
    // Phase 18 Stage 5: stash the taskPlan gate so the normalizer's
    // defensive drop can see the run's intent + complexity.
    this.setRunTaskPlanGate(payload)

    try {
      let history = this.runState.get(payload.runId) as AnthropicMessage[] | undefined

      if (!payload.toolResult && !payload.toolResults) {
        // First call — new conversation. The Anthropic API takes the
        // system prompt as a top-level field, NOT as a leading message,
        // so we DON'T prepend a system entry to history (unlike OpenAI).
        history = [
          { role: "user", content: this.buildInitialUserMessage(payload) },
        ]
        this.runState.set(payload.runId, history)
        this.setRunTask(payload.runId, payload.userMessage)
      } else {
        // Continuation — append tool result(s) as a new user turn.
        if (!this.runTasks.has(payload.runId) && payload.userMessage) {
          this.setRunTask(payload.runId, payload.userMessage)
        }
        const toolMsg = this.buildToolResultMessage(payload)

        if (!history) {
          history = [
            { role: "user", content: `Previous ${toolMsg}` },
          ]
          this.runState.set(payload.runId, history)
        } else {
          history.push({ role: "user", content: toolMsg })
        }
      }

      const MAX_RETRIES = 2
      let response: Response | undefined
      let lastError: Error | undefined
      const maxTokensCap = this.getAdaptiveMaxTokens(8192)

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          const controller = new AbortController()
          const timeout = setTimeout(() => controller.abort(), 120_000)

          response = await fetch(API_URL, {
            method: "POST",
            headers: {
              "x-api-key": apiKey,
              "anthropic-version": ANTHROPIC_API_VERSION,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              // Stage B: `system` is rebuilt per request so reasoning briefs
              // (preflight implement/bug/decision/summary, elaboration) reach
              // the model. Before this change Anthropic used the static
              // SHARED_SYSTEM_PROMPT and never saw any brief content.
              model: modelName,
              system: this.getSystemPromptForRequest(payload),
              messages: history,
              max_tokens: maxTokensCap,
              temperature: 0.1,
            }),
            signal: controller.signal,
          })

          clearTimeout(timeout)

          // Anthropic doesn't have a 402 affordability dance like
          // OpenRouter — your account is billed straight from credit, so
          // the only fail modes are auth, rate-limit, or input-too-long.
          break
        } catch (fetchErr) {
          lastError = fetchErr as Error
          console.error(`[anthropic] Fetch attempt ${attempt + 1} failed:`, lastError.message)
          if (attempt < MAX_RETRIES) {
            await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)))
          }
        }
      }

      if (!response) {
        throw lastError || new Error("Anthropic fetch failed after retries")
      }

      if (!response.ok) {
        const errBody = await response.text()
        const status = response.status
        console.error(`[anthropic] HTTP ${status}:`, errBody)

        // Rate limit — DON'T clear run state, signal for retry/fallback.
        if (status === 429) {
          return this.rateLimitedResponse(`Anthropic rate limit (429). Details: ${errBody.slice(0, 200)}`)
        }

        this.clearRunState(payload.runId)

        if (status === 401 || status === 403) {
          return this.failedResponse(`Anthropic auth error (${status}). Check your ANTHROPIC_API_KEY.`)
        }
        if (status === 400 && errBody.includes("max_tokens")) {
          return this.failedResponse(
            `Anthropic rejected the request: ${errBody.slice(0, 240)}. ` +
            `Try reducing the prompt size — Sonnet/Opus have a 200k context window but max_tokens output is capped at 8192.`,
          )
        }
        return this.failedResponse(`Anthropic error ${status}: ${errBody.slice(0, 300)}`)
      }

      const data = await response.json() as {
        content?: Array<{ type?: string; text?: string }>
        usage?: { input_tokens?: number; output_tokens?: number }
        stop_reason?: string
      }

      const usage: TokenUsage = {
        inputTokens: data.usage?.input_tokens || 0,
        outputTokens: data.usage?.output_tokens || 0,
      }

      // Anthropic returns content as an array of blocks. For text-only
      // responses (which is what our JSON-envelope flow produces), the
      // first block's `text` is the whole answer. Concatenate any
      // additional text blocks defensively.
      const assistantMessage = (data.content ?? [])
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text as string)
        .join("")

      // Add assistant response to history for multi-turn.
      history!.push({ role: "assistant", content: assistantMessage })

      let normalized = this.parseJsonResponse(assistantMessage, payload.runId)
      normalized.usage = usage
      this.onSuccessfulCall()

      // Layer 2: provider-level completion validation — same guard the
      // OpenRouter provider applies, prevents the model from claiming
      // completion before any tools have run.
      normalized = this.validateCompletionResponse(payload.runId, normalized)

      if (normalized.kind === "completed" || normalized.kind === "failed") {
        this.clearRunState(payload.runId)
      }

      return normalized
    } catch (err) {
      this.clearRunState(payload.runId)

      const errMsg = (err as Error).message || ""
      console.error("[anthropic] Error:", errMsg)

      if (errMsg.includes("ANTHROPIC_API_KEY")) {
        return this.failedResponse("ANTHROPIC_API_KEY is not set in .env")
      }

      return this.failedResponse(`Anthropic error: ${errMsg}`)
    }
  }
}
