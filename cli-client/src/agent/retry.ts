/**
 * Error classification + bounded retry helper for the CLI agent loop.
 *
 * Replaces the ad-hoc `if (errMsg.includes("rate limit"))` pattern that was
 * sprinkled across `runAgent` with a single `classifyError` switch and a
 * `withRetry` async helper used by the controller.
 */

import type { ServerError } from "../lib/server.js"
import { getFlag } from "./flags.js"

export type RetryClass =
  | "usage_limit"
  | "rate_limit"
  | "session_expired"
  | "transient_network"
  | "fatal"

export function classifyError(err: unknown): RetryClass {
  if (!(err instanceof Error)) return "fatal"
  const code = (err as ServerError).code
  if (code === "USAGE_LIMIT") return "usage_limit"
  if (code === "RATE_LIMIT") return "rate_limit"
  if (code === "SESSION_EXPIRED") return "session_expired"
  if (code === "NETWORK") return "transient_network"

  const msg = err.message.toLowerCase()
  if (msg.includes("usage limit")) return "usage_limit"
  if (msg.includes("rate limit") || msg.includes("429") || msg.includes("quota") || msg.includes("resource_exhausted")) {
    return "rate_limit"
  }
  if (msg.includes("session expired") || msg.includes("run not found")) return "session_expired"
  if (msg.includes("econnreset") || msg.includes("epipe") || msg.includes("etimedout") || msg.includes("network")) {
    return "transient_network"
  }
  return "fatal"
}

export interface RetryOptions {
  maxRetries: number
  baseDelayMs: number
  maxDelayMs: number
  /** Called with attempt index (0-based), the chosen delay, and the classified error. */
  onRetry?: (attempt: number, delayMs: number, cls: RetryClass, err: Error) => void
}

function defaultMaxRetries(): number {
  try {
    return getFlag<number>("cli.retry_max_default")
  } catch {
    return 10
  }
}

const DEFAULT_OPTIONS: RetryOptions = {
  get maxRetries() { return defaultMaxRetries() },
  baseDelayMs: 1_000,
  maxDelayMs: 32_000,
} as RetryOptions

/**
 * Run `fn` with classification-aware exponential backoff. Returns the resolved
 * value from `fn`. Re-throws fatal classifications immediately. Re-throws the
 * last error after exhausting retries.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: Partial<RetryOptions> = {},
): Promise<T> {
  const opts: RetryOptions = { ...DEFAULT_OPTIONS, ...options }
  let attempt = 0
  let lastError: Error | null = null

  while (attempt <= opts.maxRetries) {
    try {
      return await fn()
    } catch (err) {
      lastError = err as Error
      const cls = classifyError(err)

      if (cls === "fatal" || cls === "session_expired") throw err
      if (attempt >= opts.maxRetries) throw err

      const delay = Math.min(
        opts.baseDelayMs * Math.pow(2, attempt) + Math.floor(Math.random() * 1_000),
        opts.maxDelayMs,
      )
      opts.onRetry?.(attempt, delay, cls, err as Error)
      await sleep(delay)
      attempt++
    }
  }

  throw lastError ?? new Error("withRetry exhausted retries")
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
