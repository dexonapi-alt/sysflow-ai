import type { NormalizedResponse, ClientResponse, ServerErrorCode } from "../types.js"

/**
 * Stage 1 of plan 2026-05-16-reasoning-chain-provider-parity.md.
 *
 * Resolve `perTurnReasoningChain` from a NormalizedResponse:
 *   - When `reasoningChain[]` is a non-empty array → use it verbatim
 *     (the model populated the structured field; richer).
 *   - When the array is empty/missing BUT `reasoning` (singular string)
 *     is a non-empty trimmed value → synthesise a single-element
 *     chain from it so the cli still sees fresh per-turn deliberation.
 *   - Otherwise → undefined.
 *
 * This is the provider-parity fix: models served via OpenRouter /
 * Anthropic (especially CJS-shaped or smaller free-tier ones) often
 * emit `response.reasoning` (legacy field) instead of the structured
 * `reasoningChain[]`. Without synthesis the cli's `<ReasoningPeek>`
 * stays stuck on the FIRST brief that DID emit a chain
 * (`project_init` or `intent_classification`) for the rest of the run.
 *
 * Pure; exported for tests. Used by both `needs_tool` and `completed`
 * envelopes — anywhere per-turn deliberation may land.
 */
export function resolvePerTurnReasoningChain(normalized: NormalizedResponse): string[] | undefined {
  if (Array.isArray(normalized.reasoningChain) && normalized.reasoningChain.length > 0) {
    return normalized.reasoningChain
  }
  if (typeof normalized.reasoning === "string") {
    const trimmed = normalized.reasoning.trim()
    if (trimmed.length > 0) return [trimmed]
  }
  return undefined
}

function classifyFailureErrorCode(error: string | undefined): ServerErrorCode {
  if (!error) return "unknown"
  const lower = error.toLowerCase()
  if (lower.includes("malformed json") || lower.includes("malformed model")) return "malformed_response"
  if (lower.includes("session expired") || lower.includes("run not found")) return "session_expired"
  if (lower.includes("usage limit")) return "usage_limit"
  if (lower.includes("rate limit") || lower.includes("429") || lower.includes("quota")) return "rate_limit"
  if (lower.includes("prompt too long") || lower.includes("tokens) exceeds")) return "prompt_too_long"
  if (lower.includes("max-output-tokens") || lower.includes("max_output_tokens")) return "unknown" // surfaces in CLI as a regular failure for now
  return "unknown"
}

export function mapNormalizedResponseToClient(runId: string, normalized: NormalizedResponse): ClientResponse {
  switch (normalized.kind) {
    case "needs_tool":
      return {
        status: "needs_tool",
        runId,
        tool: normalized.tool,
        args: normalized.args,
        tools: normalized.tools || undefined,
        content: normalized.content || null,
        reasoning: normalized.reasoning || null,
        task: normalized.task || null,
        taskStep: normalized.taskStep || null,
        stepTransition: normalized.stepTransition || undefined,
        // Stage 1 of reasoning-chain-provider-parity plan extends the
        // Stage-3 agent-runtime-fixes resolution: synthesises a chain
        // from singular `reasoning` when the model didn't structure
        // its output. Closes the provider-parity gap where openrouter /
        // anthropic models often emit only the legacy `reasoning` field.
        perTurnReasoningChain: resolvePerTurnReasoningChain(normalized),
      }

    case "waiting_for_user":
      return {
        status: "waiting_for_user",
        runId,
        message: normalized.content,
        pendingAction: normalized.pendingAction || null
      }

    case "completed":
      return {
        status: "completed",
        runId,
        message: normalized.content,
        summary: normalized.summary || null,
        reasoning: normalized.reasoning || null,
        perTurnReasoningChain: resolvePerTurnReasoningChain(normalized),
      }

    case "failed":
      return {
        status: "failed",
        runId,
        error: normalized.error,
        errorCode: classifyFailureErrorCode(normalized.error)
      }

    case "rate_limited":
      // Should be caught by adapter retry/fallback — if it leaks here, map to failed
      return {
        status: "failed",
        runId,
        error: normalized.error || "Rate limited — all fallback models exhausted",
        errorCode: "rate_limit"
      }

    default:
      return {
        status: "failed",
        runId,
        error: "Unknown normalized response kind"
      }
  }
}
