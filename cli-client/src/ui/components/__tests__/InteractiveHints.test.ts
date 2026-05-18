import { describe, it, expect } from "vitest"
import { deriveHintState } from "../InteractiveHints.js"

describe("deriveHintState", () => {
  it("returns 'idle' when spinnerText is null AND no modal is active", () => {
    expect(deriveHintState(null, null)).toBe("idle")
  })

  it("returns 'working' when spinnerText is a non-empty string AND no modal is active", () => {
    expect(deriveHintState("thinking…", null)).toBe("working")
  })

  it("returns 'working' even for an empty-string spinnerText (the bus uses empty-string for the un-textured spinner)", () => {
    // The reducer normalises a `{type: "spinner"}` event with no text to
    // `spinnerText: ""` (truthy presence, no label) — that should still
    // count as working.
    expect(deriveHintState("", null)).toBe("working")
  })

  it("never throws on the union it is contracted to handle", () => {
    expect(() => deriveHintState(null, null)).not.toThrow()
    expect(() => deriveHintState("x", null)).not.toThrow()
  })

  // Stage 5 of plan 2026-05-18-ui-ux-polish-and-action-aware-spinner.md (audit issue #5).
  it("returns 'permission_modal' when permission modal is active (even with spinner running)", () => {
    expect(deriveHintState("thinking…", "permission")).toBe("permission_modal")
    expect(deriveHintState(null, "permission")).toBe("permission_modal")
  })

  it("returns 'offcourse_modal' when off-course modal is active (even with spinner running)", () => {
    expect(deriveHintState("thinking…", "offcourse")).toBe("offcourse_modal")
    expect(deriveHintState(null, "offcourse")).toBe("offcourse_modal")
  })

  it("modal state wins over spinner state — the user's hint priority is what's actively listening for keys", () => {
    expect(deriveHintState("executing 3 tools…", "permission")).toBe("permission_modal")
    expect(deriveHintState("executing 3 tools…", "offcourse")).toBe("offcourse_modal")
  })
})
