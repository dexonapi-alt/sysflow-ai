/**
 * Stage 5 of plan 2026-05-18-ui-ux-polish-and-action-aware-spinner.md
 * (audit issue #7): pure tests for the stream preview line formatter.
 */

import { describe, it, expect } from "vitest"
import { formatStreamLine } from "../StreamPreview.js"

describe("formatStreamLine — display normalisation", () => {
  it("returns the line verbatim when within budget", () => {
    expect(formatStreamLine("added 3 packages")).toBe("added 3 packages")
  })

  it("strips trailing whitespace", () => {
    expect(formatStreamLine("npm WARN deprecated   ")).toBe("npm WARN deprecated")
    expect(formatStreamLine("ok\n\r")).toBe("ok")
  })

  it("collapses tabs to single spaces", () => {
    expect(formatStreamLine("line\twith\ttabs")).toBe("line with tabs")
  })

  it("truncates over-long lines with an ellipsis at the 70-char budget", () => {
    const long = "a".repeat(100)
    const out = formatStreamLine(long)
    expect(out.length).toBe(70)
    expect(out.endsWith("…")).toBe(true)
  })

  it("does not throw / returns empty on non-string input (defensive)", () => {
    expect(formatStreamLine(42 as unknown as string)).toBe("")
    expect(formatStreamLine(null as unknown as string)).toBe("")
    expect(formatStreamLine(undefined as unknown as string)).toBe("")
  })

  it("handles empty string as empty", () => {
    expect(formatStreamLine("")).toBe("")
  })

  it("preserves internal whitespace (between words)", () => {
    expect(formatStreamLine("npm  install  --production")).toBe("npm  install  --production")
  })
})
