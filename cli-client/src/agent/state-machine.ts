/**
 * Explicit transition types for the agent loop.
 *
 * Today the loop is `while(true) switch(response.status)`. This module gives
 * each iteration outcome a name so the controller can read like a finite-state
 * machine rather than a chain of conditionals.
 *
 * Not (yet) a true async-generator queryLoop — that's the follow-up plan.
 */

export type TerminalReason =
  | "completed"
  | "failed"
  | "session_expired"
  | "usage_limit_exhausted"
  | "rate_limit_exhausted"
  | "max_consecutive_errors"
  | "prompt_too_long"
  | "malformed_response_exhausted"
  | "user_cancelled"

export type ContinueReason =
  | "next_turn"
  | "tool_executed"
  | "tool_batch_executed"
  | "user_responded"
  | "completion_rejected"
  | "rate_limit_retry"
  | "usage_limit_retry"
  | "failure_retry"

export type Transition =
  | { terminal: true; reason: TerminalReason; payload?: Record<string, unknown> }
  | { terminal: false; reason: ContinueReason; payload?: Record<string, unknown> }

export interface ServerResponse {
  status?: string
  error?: string
  errorCode?: string
  message?: string | null
  content?: string | null
  runId?: string
  tool?: string
  tools?: unknown
  // ...other fields, not exhaustive
  [k: string]: unknown
}

/**
 * Read a server response and decide what the loop should do next. The controller
 * still owns side effects (printing, executing tools) — this just classifies.
 */
export function classifyResponse(response: ServerResponse): Transition {
  switch (response.status) {
    case "completed":
      return { terminal: true, reason: "completed" }
    case "needs_tool":
      return Array.isArray(response.tools) && response.tools.length > 1
        ? { terminal: false, reason: "tool_batch_executed" }
        : { terminal: false, reason: "tool_executed" }
    case "waiting_for_user":
      return { terminal: false, reason: "user_responded" }
    case "failed": {
      const code = (response.errorCode as string) || ""
      const msg = (response.error || "").toLowerCase()
      if (code === "session_expired" || msg.includes("session expired") || msg.includes("run not found")) {
        return { terminal: true, reason: "session_expired" }
      }
      if (code === "prompt_too_long") {
        return { terminal: true, reason: "prompt_too_long" }
      }
      if (code === "malformed_response") {
        return { terminal: true, reason: "malformed_response_exhausted" }
      }
      if (code === "usage_limit") {
        return { terminal: false, reason: "usage_limit_retry" }
      }
      if (code === "rate_limit" || msg.includes("rate limit") || msg.includes("429") || msg.includes("quota")) {
        return { terminal: false, reason: "rate_limit_retry" }
      }
      return { terminal: false, reason: "failure_retry" }
    }
    default:
      return { terminal: true, reason: "failed" }
  }
}

/** Retry budgets keyed by reason. Replaces the four ad-hoc counters in agent.ts. */
export interface RetryBudget {
  rate_limit: { used: number; max: number; backoffMs: number; maxBackoffMs: number }
  usage_limit: { used: number; max: number; baseMs: number; maxBackoffMs: number }
  failure: { used: number; max: number; consecutiveErrors: number; maxConsecutive: number }
  completion_rejection: { used: number; max: number }
  malformed: { used: number; max: number }
}

export function makeRetryBudget(): RetryBudget {
  return {
    rate_limit: { used: 0, max: 8, backoffMs: 5_000, maxBackoffMs: 120_000 },
    usage_limit: { used: 0, max: 6, baseMs: 5_000, maxBackoffMs: 120_000 },
    failure: { used: 0, max: 5, consecutiveErrors: 0, maxConsecutive: 3 },
    completion_rejection: { used: 0, max: 3 },
    malformed: { used: 0, max: 2 },
  }
}

/** Reset transient counters when a successful step happens. */
export function noteSuccess(budget: RetryBudget): void {
  budget.failure.consecutiveErrors = 0
  budget.failure.used = 0
  if (budget.rate_limit.backoffMs > 5_000) {
    budget.rate_limit.backoffMs = Math.max(5_000, budget.rate_limit.backoffMs / 2)
  }
}
