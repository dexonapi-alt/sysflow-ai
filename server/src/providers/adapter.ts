import { BaseProvider, MODEL_FALLBACK_CHAINS, isProviderRateLimited, getRateLimitState } from "./base-provider.js"
import { GeminiProvider } from "./gemini.js"
import { OpenRouterProvider } from "./openrouter.js"
import { AnthropicProvider } from "./anthropic.js"
import { SweProvider } from "./swe.js"
import { getFlag } from "../services/flags.js"
import type { ProviderPayload, NormalizedResponse } from "../types.js"

// ─── Provider Registry ───

const providers: Map<string, BaseProvider> = new Map()

function registerProvider(provider: BaseProvider): void {
  for (const modelId of Object.keys(provider.modelMap)) {
    providers.set(modelId, provider)
  }
}

// Register all providers. AnthropicProvider handles both `claude-sonnet`
// and `claude-opus` user-facing IDs (replaced the day-one mock providers).
registerProvider(new GeminiProvider())
registerProvider(new OpenRouterProvider())
registerProvider(new AnthropicProvider())
registerProvider(new SweProvider())

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Stage A of model-lock-and-portable-reasoning: pure decision over whether
 * the adapter should walk MODEL_FALLBACK_CHAINS on a rate-limit.
 *
 * Returns false (lock-in) when:
 *   - `providers.lock_to_chosen_model` flag is true (default), AND
 *   - the model id is NOT an "...-auto" pick (auto picks expect cycling).
 *
 * Exported for tests.
 */
export function shouldFallback(model: string, lockEnabled: boolean): boolean {
  if (!lockEnabled) return true
  return model.endsWith("-auto")
}

/**
 * Call the model adapter with automatic retry and fallback on rate limits.
 *
 * Strategy:
 * 1. Try the primary model
 * 2. If rate_limited, wait (exponential backoff) and retry
 * 3. If the primary is exhausted (too many consecutive hits), try fallback models
 * 4. Only return failed if ALL options are exhausted
 */
export async function callModelAdapter(payload: ProviderPayload): Promise<NormalizedResponse> {
  // Try the primary model first
  const result = await callWithRetry(payload.model, payload)
  if (result.kind !== "rate_limited") return result

  // Stage A lock-in check. When `providers.lock_to_chosen_model` is on
  // (default) and the user picked an explicit single-provider model, do
  // NOT walk the fallback chain — surface a clear error so the user can
  // switch with /model instead of silently getting responses from a
  // different provider.
  const lockEnabled = (() => {
    try { return getFlag<boolean>("providers.lock_to_chosen_model") } catch { return true }
  })()
  if (!shouldFallback(payload.model, lockEnabled)) {
    console.log(`[adapter] ${payload.model} rate-limited — lock-in is on, no fallback. Run /model to swap.`)
    return {
      kind: "failed",
      error:
        `${payload.model} is rate-limited. Wait a moment and retry, or run /model to swap providers. ` +
        `(Set providers.lock_to_chosen_model=false to restore cross-provider auto-fallback.) ` +
        `Original: ${result.error}`,
      usage: { inputTokens: 0, outputTokens: 0 },
    }
  }

  // Primary exhausted — try fallback chain (only reachable for auto picks
  // when lock-in is on, or any model when lock-in is off).
  const fallbacks = MODEL_FALLBACK_CHAINS[payload.model] || []
  for (const fallbackModel of fallbacks) {
    const fbProvider = providers.get(fallbackModel)
    if (!fbProvider) continue
    if (isProviderRateLimited(fbProvider.name)) {
      console.log(`[adapter] Skipping fallback ${fallbackModel} — also rate limited`)
      continue
    }

    console.log(`[adapter] Falling back from ${payload.model} → ${fallbackModel}`)
    const fbPayload = { ...payload, model: fallbackModel }
    const fbResult = await callWithRetry(fallbackModel, fbPayload)
    if (fbResult.kind !== "rate_limited") return fbResult
  }

  // All options exhausted — return a failed response with retry hint
  return {
    kind: "failed",
    error: `All models rate limited. The system will auto-retry shortly. Original: ${result.error}`,
    usage: { inputTokens: 0, outputTokens: 0 }
  }
}

async function callWithRetry(modelId: string, payload: ProviderPayload): Promise<NormalizedResponse> {
  const provider = providers.get(modelId)
  if (!provider) {
    throw new Error(`Unsupported model: ${modelId}`)
  }

  const MAX_RETRIES = 3
  let lastResult: NormalizedResponse | null = null

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const result = await provider.call(payload)

    if (result.kind !== "rate_limited") {
      return result
    }

    lastResult = result
    const state = getRateLimitState(provider.name)
    if (!state) break

    // If we've hit too many times, give up on this provider
    if (state.hitCount > MAX_RETRIES) {
      console.log(`[adapter] ${provider.name} exceeded retry limit (${state.hitCount} hits), moving to fallback`)
      break
    }

    // Wait with exponential backoff before retrying
    console.log(`[adapter] Waiting ${state.backoffMs}ms before retry #${attempt + 1} on ${provider.name}`)
    await sleep(state.backoffMs)
  }

  return lastResult || { kind: "rate_limited", error: "Rate limited", usage: { inputTokens: 0, outputTokens: 0 } }
}
