/**
 * Stage 5 of plan 2026-05-18-ui-ux-polish-and-action-aware-spinner.md
 * (audit issue #6): pure tests for the width-aware permission-modal
 * box-width policy.
 *
 * Pre-Stage-5 the box was hardcoded to 64 cols — wrapped on narrow
 * terminals (60-col iTerm2 split panes), under-used wide terminals
 * (120-col single panes truncated diff lines that were perfectly
 * readable).
 */

import { describe, it, expect } from "vitest"
import { pickPermissionBoxWidth, truncateTargetForPermissionLabel } from "../permission-prompt.js"

describe("pickPermissionBoxWidth — width policy", () => {
  it("uses the default 64 when columns is undefined / 0 / negative (non-TTY)", () => {
    expect(pickPermissionBoxWidth(undefined)).toBe(64)
    expect(pickPermissionBoxWidth(0)).toBe(64)
    expect(pickPermissionBoxWidth(-1)).toBe(64)
  })

  it("clamps to a 32-col minimum on very narrow terminals", () => {
    expect(pickPermissionBoxWidth(10)).toBe(32)
    expect(pickPermissionBoxWidth(20)).toBe(32)
    expect(pickPermissionBoxWidth(35)).toBe(32)
  })

  it("scales with terminal width in the comfortable range", () => {
    expect(pickPermissionBoxWidth(40)).toBe(36)
    expect(pickPermissionBoxWidth(60)).toBe(56)
    expect(pickPermissionBoxWidth(80)).toBe(76)
  })

  it("caps at 80-col maximum on wide terminals", () => {
    expect(pickPermissionBoxWidth(120)).toBe(80)
    expect(pickPermissionBoxWidth(200)).toBe(80)
  })

  it("leaves 4 cols of terminal headroom (2 indent + 2 right margin)", () => {
    // 60-col terminal: box must be <= 60 - 4 = 56
    expect(pickPermissionBoxWidth(60)).toBeLessThanOrEqual(60 - 4)
    expect(pickPermissionBoxWidth(60)).toBe(56)
  })

  it("handles non-finite inputs defensively (NaN, Infinity)", () => {
    expect(pickPermissionBoxWidth(Number.NaN)).toBe(64)
    expect(pickPermissionBoxWidth(Number.POSITIVE_INFINITY)).toBe(64)
  })
})

// Plan 2026-05-18-batch-heading-and-permission-label-polish.md issue #4.
describe("truncateTargetForPermissionLabel — long-target overflow guard", () => {
  it("returns the target verbatim when it fits inside the box", () => {
    expect(truncateTargetForPermissionLabel("src/index.ts", "write_file", 64)).toBe("src/index.ts")
  })

  it("truncates with ellipsis when the target would push the closing paren off the right edge (user repro)", () => {
    const long = "node --check src/middleware/errorHandler.js"
    const out = truncateTargetForPermissionLabel(long, "run_command", 64)
    expect(out.length).toBeLessThan(long.length)
    expect(out.endsWith("…")).toBe(true)
  })

  it("respects a wider box: more budget on a wider modal", () => {
    const long = "node --check src/middleware/errorHandler.js"
    const narrow = truncateTargetForPermissionLabel(long, "run_command", 64)
    const wide = truncateTargetForPermissionLabel(long, "run_command", 80)
    // Wider box → more chars survive (or the full string fits).
    expect(wide.length).toBeGreaterThan(narrow.length)
  })

  it("aggressively shortens on a very narrow box (no room to render)", () => {
    const out = truncateTargetForPermissionLabel("src/index.ts", "write_file", 32)
    // Budget is tight; the helper falls back to a hard cap.
    expect(out.length).toBeLessThanOrEqual(8)
  })

  it("returns the verbatim target when empty / non-string (defensive)", () => {
    expect(truncateTargetForPermissionLabel("", "run_command", 64)).toBe("")
    expect(truncateTargetForPermissionLabel(undefined as unknown as string, "run_command", 64)).toBe(undefined as unknown as string)
  })

  it("budget scales with tool name length (longer tool → smaller target budget)", () => {
    const long = "node --check src/middleware/errorHandler.js"
    const shortTool = truncateTargetForPermissionLabel(long, "x", 64)
    const longTool = truncateTargetForPermissionLabel(long, "run_command", 64)
    // With the shorter tool, more room for target.
    expect(shortTool.length).toBeGreaterThanOrEqual(longTool.length)
  })
})
