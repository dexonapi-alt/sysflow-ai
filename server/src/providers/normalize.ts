import type { NormalizedResponse, ClientResponse, ServerErrorCode } from "../types.js"

function classifyFailureErrorCode(error: string | undefined): ServerErrorCode {
  if (!error) return "unknown"
  const lower = error.toLowerCase()
  if (lower.includes("malformed json") || lower.includes("malformed model")) return "malformed_response"
  if (lower.includes("session expired") || lower.includes("run not found")) return "session_expired"
  if (lower.includes("usage limit")) return "usage_limit"
  if (lower.includes("rate limit") || lower.includes("429") || lower.includes("quota")) return "rate_limit"
  if (lower.includes("prompt too long") || lower.includes("tokens) exceeds")) return "prompt_too_long"
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
        stepTransition: normalized.stepTransition || undefined
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
        reasoning: normalized.reasoning || null
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
