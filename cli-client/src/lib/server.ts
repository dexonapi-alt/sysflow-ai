import chalk from "chalk"
import { getAuthToken } from "./sysbase.js"
import { pauseSpinner, resumeSpinner } from "../cli/spinner-control.js"

/** Print a transient retry / network message without trampling the spinner. */
function logRetry(message: string): void {
  pauseSpinner()
  console.log("  " + chalk.dim(message))
  resumeSpinner()
}

const SERVER_URL = process.env.SYS_SERVER_URL || "http://localhost:4000"

/** Stable error codes the controller can switch on instead of string-matching. */
export type ServerErrorCode =
  | "USAGE_LIMIT"
  | "RATE_LIMIT"
  | "SESSION_EXPIRED"
  | "PROMPT_TOO_LONG"
  | "MALFORMED_RESPONSE"
  | "NETWORK"
  | "UNKNOWN"

export interface ServerError extends Error {
  code?: ServerErrorCode | string
  plan?: string
}

/**
 * Stage 3 of plan 2026-05-16-server-hardening-and-error-source-distinction.md.
 *
 * Thrown to signal the outer retry loop that this failure is NOT
 * recoverable — retrying would burn budget against the same root
 * cause that won't resolve until the user takes action. Used for:
 *   - Postgres constraint violations (NOT NULL / unique / FK / CHECK)
 *   - Application validation errors (validation_failure / ValidationError /
 *     invalid_payload / malformed_response)
 *   - Server-tagged sysflow_infra error envelopes (set by Stage 2
 *     provider tagging)
 *
 * `instanceof NonRetryableError` is the contract the retry loop uses
 * to skip the retry — string-pattern checks on the error message
 * miss SSE-event-thrown errors that drop the conventional `Server
 * error` prefix.
 */
export class NonRetryableError extends Error {
  readonly signature: string
  constructor(message: string, signature: string) {
    super(message)
    this.name = "NonRetryableError"
    this.signature = signature
  }
}

const NON_RETRYABLE_SIGNATURES: Array<{ pattern: RegExp; label: string }> = [
  // Postgres constraint violations — schema-level, won't resolve via retry.
  { pattern: /violates\s+not-null\s+constraint/i, label: "pg_not_null_violation" },
  { pattern: /violates\s+unique\s+constraint/i, label: "pg_unique_violation" },
  { pattern: /violates\s+foreign\s+key\s+constraint/i, label: "pg_fk_violation" },
  { pattern: /violates\s+check\s+constraint/i, label: "pg_check_violation" },
  // Application validation — request shape is wrong; same request would
  // fail the same way next time.
  { pattern: /\bvalidation_failure\b/, label: "app_validation_failure" },
  { pattern: /\bValidationError\b/, label: "app_validation_error" },
  { pattern: /\binvalid_payload\b/, label: "app_invalid_payload" },
  { pattern: /\bmalformed_response\b/, label: "app_malformed_response" },
  // Server-tagged sysflow_infra (Stage 2 provider tagging). The
  // envelope JSON is in the error body for failed responses.
  { pattern: /"errorSource"\s*:\s*"sysflow_infra"/, label: "sysflow_infra" },
]

/**
 * Pure: inspect a server-side error body / message and return the
 * matched non-retryable signature label, or null when nothing
 * matches (signals the legacy retry path can fire).
 */
export function classifyNonRetryable(text: string): string | null {
  if (!text || typeof text !== "string") return null
  for (const { pattern, label } of NON_RETRYABLE_SIGNATURES) {
    if (pattern.test(text)) return label
  }
  return null
}

// ─── Stage 5 of server-hardening plan: per-run telemetry counter ───
//
// Bumped each time the cli throws a `NonRetryableError` instead of
// retrying a 5xx (Stage 3). Read by `agent.ts: runAgent` at terminal
// exit + reset via `resetNonRetryable5xxCount` for the next run.
// Sustained nonzero values mean the server is emitting more validation
// / constraint-violation 5xx than normal — signal to investigate.

let _nonRetryable5xxThisRun = 0

export function getNonRetryable5xxCount(): number {
  return _nonRetryable5xxThisRun
}

export function resetNonRetryable5xxCount(): void {
  _nonRetryable5xxThisRun = 0
}

function bumpNonRetryable5xxCount(): void {
  _nonRetryable5xxThisRun += 1
}

export interface StreamEvent {
  type: "phase" | "result" | "error"
  data: Record<string, unknown>
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Parse a 429 response — throws USAGE_LIMIT or returns null if not a billing limit */
function parse429(text: string, status: number): never | null {
  if (status !== 429) return null
  try {
    const data = JSON.parse(text)
    if (data.status === "usage_limit") {
      const err: ServerError = new Error(data.error || "Usage limit reached")
      err.code = "USAGE_LIMIT"
      err.plan = data.plan
      throw err
    }
  } catch (e) {
    if ((e as ServerError).code === "USAGE_LIMIT") throw e
  }
  return null
}

/** Check for session expired errors */
function checkSessionExpired(text: string): Record<string, unknown> | null {
  try {
    const data = JSON.parse(text)
    if (data.error && (data.error.includes("Run not found") || data.error.includes("Session expired"))) {
      return { status: "failed", runId: null, error: "Session expired. The server was restarted. Please run your prompt again or use sys continue." }
    }
  } catch { /* not JSON */ }
  return null
}

const MAX_SERVER_RETRIES = 3
const SERVER_RETRY_BASE_MS = 3000

export async function callServer(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const authToken = await getAuthToken()
  const bearerToken = authToken || process.env.SYS_TOKEN || "YOUR_TOKEN"

  let lastError: Error | null = null

  for (let attempt = 0; attempt <= MAX_SERVER_RETRIES; attempt++) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 300000)

    try {
      const res = await fetch(`${SERVER_URL}/agent/run`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${bearerToken}`
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      })

      if (!res.ok) {
        const text = await res.text()

        // Billing usage limit — throw immediately (caller handles retry)
        parse429(text, res.status)

        // API rate limit (429 but not billing) — retry with backoff
        if (res.status === 429 && attempt < MAX_SERVER_RETRIES) {
          const waitMs = SERVER_RETRY_BASE_MS * Math.pow(2, attempt)
          logRetry(`rate limited — retrying in ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1}/${MAX_SERVER_RETRIES})`)
          await sleepMs(waitMs)
          continue
        }

        // Session expired
        const expired = checkSessionExpired(text)
        if (expired) return expired

        // Stage 3 of server-hardening plan: non-retryable 5xx with
        // diagnostic body (PG constraint violation / validation
        // error / sysflow_infra) → throw NonRetryableError so the
        // outer catch skips the retry. Without this the cli kept
        // retrying the same DB-constraint 500 three times before
        // giving up.
        const sig = classifyNonRetryable(text)
        if (sig) {
          bumpNonRetryable5xxCount()
          throw new NonRetryableError(`Server error ${res.status}: ${text}`, sig)
        }

        throw new Error(`Server error ${res.status}: ${text}`)
      }

      return res.json() as Promise<Record<string, unknown>>
    } catch (err) {
      if ((err as ServerError).code === "USAGE_LIMIT") throw err
      // Stage 3: non-retryable failures bypass the retry loop entirely.
      if (err instanceof NonRetryableError) throw err
      lastError = err as Error

      // Network/timeout errors — retry
      if (attempt < MAX_SERVER_RETRIES && !(err as Error).message?.includes("Server error")) {
        const waitMs = SERVER_RETRY_BASE_MS * Math.pow(2, attempt)
        logRetry(`network error — retrying in ${Math.round(waitMs / 1000)}s`)
        await sleepMs(waitMs)
        continue
      }
      throw err
    } finally {
      clearTimeout(timeout)
    }
  }

  throw lastError || new Error("callServer exhausted retries")
}

/**
 * Call server with SSE streaming for real-time progress updates.
 * Yields phase events, then returns the final result.
 * Retries on 429 (non-billing) with exponential backoff.
 */
export async function callServerStream(
  payload: Record<string, unknown>,
  onPhase?: (label: string) => void
): Promise<Record<string, unknown>> {
  const authToken = await getAuthToken()
  const bearerToken = authToken || process.env.SYS_TOKEN || "YOUR_TOKEN"

  let lastError: Error | null = null

  for (let attempt = 0; attempt <= MAX_SERVER_RETRIES; attempt++) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 300000)

    try {
      const res = await fetch(`${SERVER_URL}/agent/stream`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${bearerToken}`
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      })

      if (!res.ok) {
        const text = await res.text()

        // Billing usage limit — throw immediately
        parse429(text, res.status)

        // API rate limit — retry with backoff
        if (res.status === 429 && attempt < MAX_SERVER_RETRIES) {
          const waitMs = SERVER_RETRY_BASE_MS * Math.pow(2, attempt)
          logRetry(`rate limited — retrying in ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1}/${MAX_SERVER_RETRIES})`)
          await sleepMs(waitMs)
          continue
        }

        // Session expired
        const expired = checkSessionExpired(text)
        if (expired) return expired

        // Stage 3 of server-hardening plan: non-retryable signature detection.
        const sig = classifyNonRetryable(text)
        if (sig) {
          bumpNonRetryable5xxCount()
          throw new NonRetryableError(`Server error ${res.status}: ${text}`, sig)
        }

        throw new Error(`Server error ${res.status}: ${text}`)
      }

      // Parse SSE stream
      const body = res.body
      if (!body) throw new Error("No response body")

      const reader = body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      let finalResult: Record<string, unknown> | null = null

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })

        // Process complete SSE messages
        const lines = buffer.split("\n")
        buffer = lines.pop() || "" // Keep incomplete line in buffer

        let currentEvent = ""
        let currentData = ""

        for (const line of lines) {
          if (line.startsWith("event: ")) {
            currentEvent = line.slice(7).trim()
          } else if (line.startsWith("data: ")) {
            currentData = line.slice(6).trim()
          } else if (line === "" && currentEvent && currentData) {
            try {
              const parsed = JSON.parse(currentData)

              if (currentEvent === "phase" && onPhase) {
                onPhase(parsed.label || parsed.phase)
              } else if (currentEvent === "result") {
                finalResult = parsed
              } else if (currentEvent === "error") {
                if (parsed.status === "usage_limit") {
                  const err: ServerError = new Error(parsed.error || "Usage limit reached")
                  err.code = "USAGE_LIMIT"
                  err.plan = parsed.plan
                  throw err
                }
                // Stage 3 of server-hardening plan: SSE error events
                // get the same non-retryable classification as HTTP
                // body errors. Without this the SSE-event path dropped
                // the "Server error" prefix → outer catch's substring
                // check failed → retry fired against unrecoverable
                // failures (the user's repro: 500 + DB-constraint
                // body retried 3x before halt).
                const errBody = parsed.error || JSON.stringify(parsed)
                const sig = classifyNonRetryable(errBody)
                if (sig) {
                  bumpNonRetryable5xxCount()
                  throw new NonRetryableError(errBody, sig)
                }
                throw new Error(parsed.error || "Server error")
              }
            } catch (e) {
              if ((e as ServerError).code === "USAGE_LIMIT") throw e
              if (e instanceof NonRetryableError) throw e
              if ((e as Error).message === "Server error") throw e
              // Ignore parse errors for partial data
            }
            currentEvent = ""
            currentData = ""
          }
        }
      }

      if (!finalResult) {
        throw new Error("Stream ended without result")
      }

      return finalResult
    } catch (err) {
      if ((err as ServerError).code === "USAGE_LIMIT") throw err
      // Stage 3 of server-hardening plan: non-retryable failures bypass
      // the retry loop entirely.
      if (err instanceof NonRetryableError) throw err
      lastError = err as Error

      // Network/timeout errors — retry
      if (attempt < MAX_SERVER_RETRIES && !(err as Error).message?.includes("Server error")) {
        const waitMs = SERVER_RETRY_BASE_MS * Math.pow(2, attempt)
        logRetry(`network error — retrying in ${Math.round(waitMs / 1000)}s`)
        await sleepMs(waitMs)
        continue
      }
      throw err
    } finally {
      clearTimeout(timeout)
    }
  }

  throw lastError || new Error("callServerStream exhausted retries")
}
