/**
 * Plan `2026-05-16-server-hardening-and-error-source-distinction.md` Stage 3.
 *
 * Tests for the cli's non-retryable failure classifier. The cli's
 * retry loop previously retried any 5xx that didn't have the literal
 * "Server error" prefix in the message — which meant SSE-event
 * error paths (which throw the raw error body) got retried even
 * when the body was a Postgres NOT NULL violation or a validation
 * error that wouldn't resolve via retry.
 *
 * `classifyNonRetryable(text)` returns the matched signature label
 * (for telemetry) or null when the legacy retry path should fire.
 * `NonRetryableError` is the bypass contract — `instanceof` check
 * skips the retry loop without relying on message substring.
 */

import { describe, it, expect } from "vitest"
import { classifyNonRetryable, NonRetryableError } from "../server.js"

describe("classifyNonRetryable — Postgres constraint violations", () => {
  it("matches NOT NULL violation (the user's repro)", () => {
    const text = `{"status":"failed","error":"null value in column \\"tool\\" of relation \\"tool_results\\" violates not-null constraint"}`
    expect(classifyNonRetryable(text)).toBe("pg_not_null_violation")
  })

  it("matches unique constraint violation", () => {
    const text = `duplicate key value violates unique constraint "runs_pkey"`
    expect(classifyNonRetryable(text)).toBe("pg_unique_violation")
  })

  it("matches foreign key violation", () => {
    const text = `insert or update on table "x" violates foreign key constraint "fk"`
    expect(classifyNonRetryable(text)).toBe("pg_fk_violation")
  })

  it("matches check constraint violation", () => {
    const text = `new row violates check constraint "positive_amount"`
    expect(classifyNonRetryable(text)).toBe("pg_check_violation")
  })

  it("case-insensitive on the 'violates ... constraint' phrasing", () => {
    expect(classifyNonRetryable("VIOLATES NOT-NULL CONSTRAINT")).toBe("pg_not_null_violation")
  })
})

describe("classifyNonRetryable — application validation errors", () => {
  it("matches validation_failure marker", () => {
    expect(classifyNonRetryable(`{"errorCode":"validation_failure","error":"bad shape"}`)).toBe("app_validation_failure")
  })

  it("matches ValidationError class name", () => {
    expect(classifyNonRetryable(`ValidationError: missing required field 'tool'`)).toBe("app_validation_error")
  })

  it("matches invalid_payload code", () => {
    expect(classifyNonRetryable(`{"errorCode":"invalid_payload"}`)).toBe("app_invalid_payload")
  })

  it("matches malformed_response code", () => {
    expect(classifyNonRetryable(`{"errorCode":"malformed_response","error":"x"}`)).toBe("app_malformed_response")
  })
})

describe("classifyNonRetryable — sysflow_infra (Stage 2 tag)", () => {
  it("matches the JSON-encoded errorSource tag", () => {
    const text = `{"status":"failed","error":"OpenRouter 402","errorSource":"sysflow_infra"}`
    expect(classifyNonRetryable(text)).toBe("sysflow_infra")
  })

  it("matches with whitespace variation in the JSON", () => {
    expect(classifyNonRetryable(`{"errorSource" : "sysflow_infra"}`)).toBe("sysflow_infra")
  })

  it("does NOT match when errorSource is user_machine", () => {
    expect(classifyNonRetryable(`{"errorSource":"user_machine"}`)).toBeNull()
  })

  it("does NOT match when errorSource is unknown", () => {
    expect(classifyNonRetryable(`{"errorSource":"unknown"}`)).toBeNull()
  })
})

describe("classifyNonRetryable — should NOT match transient failures", () => {
  it("returns null for generic 'Internal Server Error'", () => {
    expect(classifyNonRetryable(`Internal Server Error`)).toBeNull()
  })

  it("returns null for empty string", () => {
    expect(classifyNonRetryable("")).toBeNull()
  })

  it("returns null for non-string input (defensive)", () => {
    expect(classifyNonRetryable(null as unknown as string)).toBeNull()
    expect(classifyNonRetryable(undefined as unknown as string)).toBeNull()
    expect(classifyNonRetryable(42 as unknown as string)).toBeNull()
  })

  it("returns null for connection/timeout errors", () => {
    expect(classifyNonRetryable(`ECONNREFUSED on 127.0.0.1:4000`)).toBeNull()
    expect(classifyNonRetryable(`network timeout`)).toBeNull()
  })

  it("returns null when 'constraint' appears in unrelated context", () => {
    // The matcher requires the canonical 'violates ... constraint'
    // phrasing — bare 'constraint' in a stack trace shouldn't trigger.
    expect(classifyNonRetryable(`stack trace mentions constraint somewhere`)).toBeNull()
  })
})

describe("NonRetryableError — bypass contract", () => {
  it("is an Error subclass", () => {
    const err = new NonRetryableError("x", "pg_not_null_violation")
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(NonRetryableError)
  })

  it("carries the signature for telemetry", () => {
    const err = new NonRetryableError("x", "sysflow_infra")
    expect(err.signature).toBe("sysflow_infra")
  })

  it("preserves the message", () => {
    const err = new NonRetryableError("Server error 500: ...", "pg_unique_violation")
    expect(err.message).toBe("Server error 500: ...")
  })

  it("has a recognisable name for stack-trace inspection", () => {
    const err = new NonRetryableError("x", "x")
    expect(err.name).toBe("NonRetryableError")
  })
})
