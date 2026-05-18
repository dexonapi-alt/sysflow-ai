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
    // Phase 18 Stage 5: stash the taskPlan gate so the normalizer's
    // defensive drop can see the run's intent + complexity.
    this.setRunTaskPlanGate(payload)

    try {
      let history = this.runState.get(payload.runId) as ChatMessage[] | undefined

      // Stage B: rebuild the system prompt per request so reasoning briefs
      // (preflight implement/bug/decision/summary, elaboration) reach the
      // model. Before this change OpenRouter used the static
      // SHARED_SYSTEM_PROMPT and never saw any brief content.
      const systemPromptForRequest = this.getSystemPromptForRequest(payload)

      if (!payload.toolResult && !payload.toolResults) {
        // First call — new conversation
        history = [
          { role: "system", content: systemPromptForRequest },
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
            { role: "system", content: systemPromptForRequest },
            { role: "user", content: `Previous ${toolMsg}` }
          ]
          this.runState.set(payload.runId, history)
        } else {
          // Stage B: refresh history[0] so mid-run brief updates (on-error /
          // on-completion / freshly-cached chunk reflections) propagate to
          // the model. For runs where the brief is stable (preflight only
          // fires once) this is a no-op replacement.
          if (history[0]?.role === "system") {
            history[0] = { role: "system", content: systemPromptForRequest }
          }
          history.push({ role: "user", content: toolMsg })
        }
      }

      const MAX_RETRIES = 2
      let response: Response | undefined
      let lastError: Error | undefined
      // 2026-05-18: base cap lowered from 32768 → 8192.
      // The pre-fix default trusted "the agent will chunk work" to bound
      // per-turn output. But chunked-loop bounds work to ≤5 files
      // (~3-6k tokens of code) per chunk, so 32768 always over-asked. A
      // user with limited credits would 402 on the FIRST request even
      // though the actual response would never have needed that much.
      // 8192 matches Anthropic's default cap, comfortably holds a
      // chunked response (5 files + reasoning + plan + envelope), and
      // halves the affordable threshold a user needs to start the run.
      // The 402 affordability retry below is still the safety net for
      // accounts that can't even afford 8192.
      let maxTokensCap = this.getAdaptiveMaxTokens(8192)

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
            // Stage 4 of server-hardening plan: classify the 402
            // BEFORE attempting a retry. Skip retry entirely when
            // either (a) the body explicitly says credits are
            // exhausted with no affordable number, or (b) the
            // parsed affordable is below MEANINGFUL_AFFORDABLE_THRESHOLD
            // (4096) — too small for any practical response even after
            // the 90% safety margin. Falls through to the failure
            // handler below which tags as sysflow_infra (Stage 2).
            const terminal = classify402Terminal(errBody)
            if (terminal) {
              console.warn(`[openrouter] 402 terminal (${terminal}) — skipping affordability retry; failing fast`)
              break
            }
            const affordable = parseAffordableTokens(errBody)
            if (affordable && affordable >= MEANINGFUL_AFFORDABLE_THRESHOLD) {
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

        // Stage 2 of server-hardening plan: tag sysflow-infra errors
        // so the cli halts cleanly + the recovery chain doesn't try
        // to "fix" them by mutating the user's project.
        if (status === 401 || status === 403) {
          return this.failedResponse(`OpenRouter auth error (${status}). Check your OPENROUTER_API_KEY.`, "sysflow_infra")
        }
        if (status === 402) {
          // The 402 envelope reaches here in two distinct shapes (per
          // classify402Terminal):
          //   "insufficient_credits" — body literally says credits are
          //     exhausted; no retry would help.
          //   "below_meaningful_threshold" — body parses an affordable
          //     number but it's below MEANINGFUL_AFFORDABLE_THRESHOLD.
          //     The user MAY still have some credits — they just don't
          //     cover the request's current max_tokens setting at the
          //     active model's rate.
          // Pre-fix the message said "out of credits" for both, which
          // mis-classifies the second case and confuses users who can
          // still re-prompt (because the next request might fit, or
          // because chunked-loop reduces output per turn). Surface the
          // affordable number directly when we have it so the user can
          // judge whether to top up, switch to /model gemini-flash, or
          // wait for the chunked-loop to land a smaller request.
          const terminal = classify402Terminal(errBody)
          const affordable = parseAffordableTokens(errBody)
          const explanation =
            terminal === "insufficient_credits"
              ? `OpenRouter says your credits are exhausted.`
              : affordable !== null
                ? `OpenRouter could only afford ${affordable} tokens on this request, which is below the minimum needed to retry usefully. You may still have remaining credit — the agent's next request might fit, or chunked-loop will land a smaller request — but this turn won't complete.`
                : `OpenRouter rejected this request as too large for your remaining credit balance.`
          return this.failedResponse(
            `${explanation} ` +
            `Top up at https://openrouter.ai/settings/credits, switch model with /model gemini-flash, ` +
            `or set GEMINI_API_KEY in server/.env (free tier from Google AI Studio). Original error: ${errBody.slice(0, 200)}`,
            "sysflow_infra"
          )
        }
        // 5xx from OpenRouter is also their infrastructure; 4xx (other than
        // auth/quota) often points at our request shape — tag as unknown
        // for the legacy retry path to handle.
        const source = status >= 500 ? "sysflow_infra" : "unknown"
        return this.failedResponse(`OpenRouter error ${status}: ${errBody.slice(0, 300)}`, source)
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
        return this.failedResponse("OPENROUTER_API_KEY is not set in .env", "sysflow_infra")
      }

      return this.failedResponse(`OpenRouter error: ${errMsg}`, "unknown")
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

/**
 * Stage 4 of plan 2026-05-16-server-hardening-and-error-source-distinction.md.
 *
 * Detect non-recoverable OpenRouter 402 patterns. Returns the matched
 * label or null when the legacy affordability-retry path can fire.
 *
 *   - "insufficient_credits" — the body says credits are exhausted
 *     without an affordable number. No retry will succeed.
 *   - "below_meaningful_threshold" — the affordable number IS present
 *     but too small for a practical chunked response.
 *   - null — affordable number is high enough that lowering max_tokens
 *     is genuinely worth retrying.
 *
 * 2026-05-18: threshold lowered from 4096 → 2048. User repro showed
 * "affordable=2708, requested=6608" failing as "out of credits" even
 * though the user had remaining credits — just not enough for the
 * 32768 default cap. At 2048, the retry path fires for affordable
 * ≥ 2048 (resulting max_tokens ≥ 1843 after the 90% margin), giving
 * the chunked-loop a chance to land a smaller request rather than
 * surfacing a misleading infra error. Chunked-loop bounds work to
 * ≤5 files per chunk so 1843-2400 max_tokens is workable for typical
 * agent turns.
 *
 * Pure; exported for tests.
 */
export const MEANINGFUL_AFFORDABLE_THRESHOLD = 2048

export function classify402Terminal(errBody: string): "insufficient_credits" | "below_meaningful_threshold" | null {
  if (!errBody || typeof errBody !== "string") return null
  // Explicit credit-exhaustion patterns OpenRouter uses.
  if (/insufficient\s+credits/i.test(errBody)) return "insufficient_credits"
  if (/you\s+have\s+used\s+all\s+your\s+credits/i.test(errBody)) return "insufficient_credits"
  // Parsed affordable too small to be useful — even at 90% safety
  // margin the resulting max_tokens won't hold a meaningful response.
  const affordable = parseAffordableTokens(errBody)
  if (affordable !== null && affordable < MEANINGFUL_AFFORDABLE_THRESHOLD) {
    return "below_meaningful_threshold"
  }
  return null
}
