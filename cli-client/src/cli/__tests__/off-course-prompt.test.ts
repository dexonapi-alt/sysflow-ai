/**
 * Stage 4 of plan 2026-05-18-ui-ux-polish-and-action-aware-spinner.md
 * (audit issue #4). Pure tests for the off-course modal's key classifier.
 *
 * Pre-Stage-4 the modal's `default → redirect` branch trapped any
 * mis-press into a 60-second text-entry the user couldn't easily back
 * out of. Stage 4 narrows the redirect branch to `r`/`R` only, adds
 * explicit `q`/`Q`/Esc handling (collapses to `continue` — the safe
 * default), and routes other keys to `unknown` so the caller re-prompts.
 */

import { describe, it, expect } from "vitest"
import { classifyOffCourseKey } from "../off-course-prompt.js"

describe("classifyOffCourseKey", () => {
  it("c / C → continue", () => {
    expect(classifyOffCourseKey("c")).toBe("continue")
    expect(classifyOffCourseKey("C")).toBe("continue")
  })

  it("b / B → backtrack", () => {
    expect(classifyOffCourseKey("b")).toBe("backtrack")
    expect(classifyOffCourseKey("B")).toBe("backtrack")
  })

  it("r / R → redirect (narrowed: previously also caught mistypes)", () => {
    expect(classifyOffCourseKey("r")).toBe("redirect")
    expect(classifyOffCourseKey("R")).toBe("redirect")
  })

  it("q / Q → continue (explicit safe cancel)", () => {
    expect(classifyOffCourseKey("q")).toBe("continue")
    expect(classifyOffCourseKey("Q")).toBe("continue")
  })

  it("Esc (0x1B) → continue (explicit safe cancel)", () => {
    expect(classifyOffCourseKey(String.fromCharCode(27))).toBe("continue")
  })

  it("any other key → unknown (caller re-prompts; pre-Stage-4 this defaulted to redirect)", () => {
    for (const key of ["a", "s", "d", "x", "z", "1", "9", "/", " ", "\t", "\n"]) {
      expect(classifyOffCourseKey(key)).toBe("unknown")
    }
  })

  it("empty string → unknown (defensive: don't collapse a missing read into a redirect)", () => {
    expect(classifyOffCourseKey("")).toBe("unknown")
  })
})
