/**
 * Plan `2026-05-16-server-hardening-and-error-source-distinction.md` Stage 2.
 *
 * Tests for the cli state-machine classifier's handling of failed
 * responses tagged with `errorSource: "sysflow_infra"`. These are
 * non-recoverable infrastructure failures (sysflow's API quota
 * exhausted, sysflow's auth misconfigured, sysflow's server-side
 * bug). Retrying would burn budget against a root cause that won't
 * resolve until the user takes action. The classifier must return
 * a `sysflow_infra` terminal so the controller renders a banner +
 * halts the run.
 */

import { describe, it, expect } from "vitest"
import { classifyResponse } from "../state-machine.js"

describe("classifyResponse — sysflow_infra terminal (Stage 2)", () => {
  it("returns terminal sysflow_infra when failed envelope tags it", () => {
    const t = classifyResponse({
      status: "failed",
      error: "OpenRouter is out of credits...",
      errorSource: "sysflow_infra",
    })
    expect(t.terminal).toBe(true)
    if (t.terminal) expect(t.reason).toBe("sysflow_infra")
  })

  it("returns terminal sysflow_infra even when error mentions retry-able keywords", () => {
    // The errorSource flag overrides the message-pattern matchers
    // (e.g. an OpenRouter quota error message often includes 'rate'
    // or 'quota' which the rate_limit matcher would catch).
    const t = classifyResponse({
      status: "failed",
      error: "OpenRouter rate quota exceeded — top up credits",
      errorSource: "sysflow_infra",
    })
    expect(t.terminal).toBe(true)
    if (t.terminal) expect(t.reason).toBe("sysflow_infra")
  })

  it("preserves legacy retry semantics when errorSource is absent", () => {
    const t = classifyResponse({
      status: "failed",
      error: "Some transient backend wobble",
    })
    expect(t.terminal).toBe(false)
    if (!t.terminal) expect(t.reason).toBe("failure_retry")
  })

  it("preserves legacy retry semantics when errorSource is 'unknown'", () => {
    const t = classifyResponse({
      status: "failed",
      error: "Generic failure",
      errorSource: "unknown",
    })
    expect(t.terminal).toBe(false)
    if (!t.terminal) expect(t.reason).toBe("failure_retry")
  })

  it("preserves legacy retry semantics when errorSource is 'user_machine'", () => {
    const t = classifyResponse({
      status: "failed",
      error: "User's tool failed",
      errorSource: "user_machine",
    })
    expect(t.terminal).toBe(false)
    if (!t.terminal) expect(t.reason).toBe("failure_retry")
  })

  it("sysflow_infra fires BEFORE session_expired matcher (errorSource wins)", () => {
    // If the error string accidentally matched 'session expired' AND
    // errorSource is sysflow_infra, sysflow_infra wins.
    const t = classifyResponse({
      status: "failed",
      error: "Provider session expired — top up",
      errorSource: "sysflow_infra",
    })
    expect(t.terminal).toBe(true)
    if (t.terminal) expect(t.reason).toBe("sysflow_infra")
  })

  it("does not affect non-failed envelopes (needs_tool / completed / waiting_for_user)", () => {
    const completed = classifyResponse({
      status: "completed",
      message: "done",
      errorSource: "sysflow_infra",  // nonsensical but should be ignored
    })
    expect(completed.terminal).toBe(true)
    if (completed.terminal) expect(completed.reason).toBe("completed")

    const needsTool = classifyResponse({
      status: "needs_tool",
      tool: "read_file",
      errorSource: "sysflow_infra",  // nonsensical but should be ignored
    })
    expect(needsTool.terminal).toBe(false)
    if (!needsTool.terminal) expect(needsTool.reason).toBe("tool_executed")
  })
})
