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

/**
 * Stage 4 of plan 2026-05-16-reasoning-chain-provider-parity.md.
 *
 * Telemetry-side classifier: tells the caller WHICH path
 * `resolvePerTurnReasoningChain` would take if called.
 *   - "structured" — the model emitted a non-empty `reasoningChain[]`
 *     (post-Stage-2 directive working as intended).
 *   - "synthesised" — only singular `reasoning` was present; Stage 1's
 *     fallback synthesised a one-element chain. Distribution-wise,
 *     spikes here mean the directive is being ignored by the model.
 *   - null — neither path produced anything. Either a non-corporeal
 *     turn (e.g. waiting_for_user) or the model emitted no
 *     deliberation at all.
 *
 * Pure; exported for tests.
 */
export type PerTurnReasoningSource = "structured" | "synthesised" | null

export function classifyPerTurnReasoningSource(normalized: NormalizedResponse): PerTurnReasoningSource {
  if (Array.isArray(normalized.reasoningChain) && normalized.reasoningChain.length > 0) {
    return "structured"
  }
  if (typeof normalized.reasoning === "string" && normalized.reasoning.trim().length > 0) {
    return "synthesised"
  }
  return null
}

/**
 * Stage 5 of plan 2026-05-16-agent-code-correctness-and-completion-artifacts.md.
 *
 * Reads the `_completionBlockedBy` marker that Stage 3 (tsc gate) /
 * Stage 4 (artifact gate) attach to the normalized envelope when they
 * override a `completed` response. Surfaces as `ClientResponse.completionBlockedBy`
 * for cli RunSummary telemetry.
 *
 * Pure; exported for tests.
 */
export function extractCompletionGateSignal(normalized: NormalizedResponse): "tsc" | "artifact_missing" | null {
  const marker = (normalized as unknown as Record<string, unknown>)._completionBlockedBy
  if (marker === "tsc" || marker === "artifact_missing") return marker
  return null
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
        // Stage 4: surface the source for telemetry. The cli increments
        // `structured` vs `synthesised` counters in RunSummary to track
        // whether Stage 2's MANDATORY directive is shifting the
        // distribution toward structured chains.
        perTurnReasoningSource: classifyPerTurnReasoningSource(normalized),
        // Stage 5 of code-correctness plan: surface completion-gate
        // override signals so the cli can count them per-run.
        completionBlockedBy: extractCompletionGateSignal(normalized),
        completionTscErrorCount: typeof (normalized as unknown as Record<string, unknown>)._completionTscErrorCount === "number"
          ? ((normalized as unknown as Record<string, unknown>)._completionTscErrorCount as number)
          : undefined,
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
        perTurnReasoningSource: classifyPerTurnReasoningSource(normalized),
      }

    case "failed":
      return {
        status: "failed",
        runId,
        error: normalized.error,
        errorCode: classifyFailureErrorCode(normalized.error),
        // Stage 2 of server-hardening plan: propagate the source
        // discriminator. Default "unknown" preserves legacy semantics
        // for any failed envelope that didn't tag.
        errorSource: normalized.errorSource ?? "unknown",
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
