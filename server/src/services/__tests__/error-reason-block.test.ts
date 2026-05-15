/**
 * Plan `2026-05-15-forced-error-reasoning-and-recovery.md` Stage 3.
 *
 * Pure-renderer tests for `buildErrorReasoningBlock`. The block is the
 * INJECT half of the forced-error-reasoning system — it lands at the
 * end of the next tool-result message body so the model is forced to
 * address the error in its `reasoningChain` before responding.
 */

import { describe, it, expect } from "vitest"
import { buildErrorReasoningBlock, isToolResultError } from "../error-reason-block.js"

const baseBrief = {
  rootCause: "cmd.exe doesn't have ls",
  platformContext: "win32 / cmd.exe",
  alternativeCommands: ["dir /s", "Get-ChildItem -Recurse", "tree /F"],
  recommendedCommand: "dir /s",
  confidence: "HIGH" as const,
}

describe("buildErrorReasoningBlock — directive content", () => {
  it("renders the canonical block header + tail markers", () => {
    const out = buildErrorReasoningBlock({
      errorText: "'ls' is not recognized as an internal or external command",
      tool: "run_command",
      brief: baseBrief,
    })
    expect(out).toContain("═══ ERROR — REASON THROUGH THIS ═══")
    expect(out).toContain("═══ END ERROR ═══")
  })

  it("names the tool that failed", () => {
    const out = buildErrorReasoningBlock({
      errorText: "permission denied",
      tool: "write_file",
      brief: baseBrief,
    })
    expect(out).toContain("`write_file`")
  })

  it("quotes the error excerpt", () => {
    const out = buildErrorReasoningBlock({
      errorText: "'ls' is not recognized as an internal or external command",
      tool: "run_command",
      brief: baseBrief,
    })
    expect(out).toContain("'ls' is not recognized")
  })

  it("surfaces the root cause + platform + recommendation + alternatives", () => {
    const out = buildErrorReasoningBlock({
      errorText: "x",
      tool: "run_command",
      brief: baseBrief,
    })
    expect(out).toContain("ROOT CAUSE (reasoner): cmd.exe doesn't have ls")
    expect(out).toContain("PLATFORM: win32 / cmd.exe")
    expect(out).toContain("RECOMMENDED: dir /s")
    expect(out).toContain("ALTERNATIVES: dir /s · Get-ChildItem -Recurse · tree /F")
  })

  it("uses SUGGESTED instead of RECOMMENDED for MEDIUM/LOW confidence", () => {
    const out = buildErrorReasoningBlock({
      errorText: "x",
      tool: "run_command",
      brief: { ...baseBrief, confidence: "MEDIUM" },
    })
    expect(out).toContain("SUGGESTED: dir /s")
    expect(out).not.toContain("RECOMMENDED: dir /s")
  })

  it("LOW confidence also uses SUGGESTED", () => {
    const out = buildErrorReasoningBlock({
      errorText: "x",
      tool: "run_command",
      brief: { ...baseBrief, confidence: "LOW" },
    })
    expect(out).toContain("SUGGESTED:")
  })

  it("includes the 4-step instruction sequence (acknowledge → reason → pick → act)", () => {
    const out = buildErrorReasoningBlock({
      errorText: "x",
      tool: "run_command",
      brief: baseBrief,
    })
    expect(out).toContain("ACKNOWLEDGE")
    expect(out).toContain("reasoningChain")
    expect(out).toContain("Reason about WHY")
    expect(out).toContain("Pick ONE")
    expect(out).toContain("Then issue the corrected tool call")
  })

  it("includes the do-not-switch-topics anti-pattern guard", () => {
    const out = buildErrorReasoningBlock({
      errorText: "x",
      tool: "run_command",
      brief: baseBrief,
    })
    // Phrase may wrap across newlines; normalise whitespace before
    // asserting so the test isn't tied to the block's exact line-
    // breaks.
    const normalised = out.replace(/\s+/g, " ")
    expect(normalised).toContain("Do NOT switch topics")
    expect(normalised).toContain("web search")
  })

  it("truncates very long error text to keep the prompt budget bounded", () => {
    const longErr = "stack trace line\n".repeat(200)  // ~3400 chars
    const out = buildErrorReasoningBlock({
      errorText: longErr,
      tool: "run_command",
      brief: baseBrief,
    })
    expect(out).toContain("…(truncated)")
    // The full error shouldn't be in the block.
    expect(out.length).toBeLessThan(longErr.length)
  })

  it("does NOT truncate short error text", () => {
    const out = buildErrorReasoningBlock({
      errorText: "short error message",
      tool: "run_command",
      brief: baseBrief,
    })
    expect(out).toContain("short error message")
    expect(out).not.toContain("…(truncated)")
  })

  it("handles empty alternatives gracefully", () => {
    const out = buildErrorReasoningBlock({
      errorText: "x",
      tool: "run_command",
      brief: { ...baseBrief, alternativeCommands: [] },
    })
    expect(out).toContain("ALTERNATIVES: (none — reasoner did not surface any)")
  })

  it("caps displayed alternatives at 5", () => {
    // Use distinctive prefixes so the assertions don't trip on
    // single-letter strings that naturally appear elsewhere in the
    // block (`f` would match "failure", `g` would match "agent", etc).
    const many = ["alt_a_x", "alt_b_x", "alt_c_x", "alt_d_x", "alt_e_x", "alt_f_x", "alt_g_x"]
    const out = buildErrorReasoningBlock({
      errorText: "x",
      tool: "run_command",
      brief: { ...baseBrief, alternativeCommands: many },
    })
    expect(out).toContain("alt_a_x · alt_b_x · alt_c_x · alt_d_x · alt_e_x")
    expect(out).not.toContain("alt_f_x")
    expect(out).not.toContain("alt_g_x")
  })

  it("leading newline is present so the block separates from prior content", () => {
    const out = buildErrorReasoningBlock({
      errorText: "x",
      tool: "run_command",
      brief: baseBrief,
    })
    expect(out.startsWith("\n")).toBe(true)
  })
})

describe("isToolResultError — gate predicate", () => {
  it("returns true when result has an error string", () => {
    expect(isToolResultError({ error: "boom" })).toBe(true)
  })

  it("returns true when result has success: false", () => {
    expect(isToolResultError({ success: false })).toBe(true)
  })

  it("returns false when result is clean", () => {
    expect(isToolResultError({ stdout: "hello" })).toBe(false)
    expect(isToolResultError({ success: true })).toBe(false)
  })

  it("returns false on `skipped: true` (explicit skip, not a failure)", () => {
    expect(isToolResultError({ skipped: true, message: "user will run manually" })).toBe(false)
  })

  it("returns false on undefined / empty / no-error", () => {
    expect(isToolResultError(undefined)).toBe(false)
    expect(isToolResultError({})).toBe(false)
    expect(isToolResultError({ error: "" })).toBe(false)
  })

  it("returns false on non-string error", () => {
    // Defense against malformed payloads.
    expect(isToolResultError({ error: null as unknown as string })).toBe(false)
    expect(isToolResultError({ error: 42 as unknown as string })).toBe(false)
  })
})
