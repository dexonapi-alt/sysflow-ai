import { describe, it, expect } from "vitest"
import { formatElapsed } from "../LiveStatusBar.js"

describe("formatElapsed", () => {
  it("renders 0ms as 0:00", () => {
    expect(formatElapsed(0)).toBe("0:00")
  })

  it("rounds sub-second values down to 0:00", () => {
    expect(formatElapsed(450)).toBe("0:00")
    expect(formatElapsed(999)).toBe("0:00")
  })

  it("renders single-digit seconds with a leading zero", () => {
    expect(formatElapsed(5_000)).toBe("0:05")
    expect(formatElapsed(9_500)).toBe("0:09")
  })

  it("renders minutes : seconds for sub-hour spans", () => {
    expect(formatElapsed(60_000)).toBe("1:00")
    expect(formatElapsed(83_000)).toBe("1:23")
    expect(formatElapsed(765_000)).toBe("12:45")
    expect(formatElapsed(3_599_000)).toBe("59:59")
  })

  it("switches to H:MM:SS once the elapsed reaches an hour", () => {
    expect(formatElapsed(3_600_000)).toBe("1:00:00")
    expect(formatElapsed(3_725_000)).toBe("1:02:05")
    expect(formatElapsed(7_323_000)).toBe("2:02:03")
  })

  it("clamps negative or non-finite values to 0:00 (defensive)", () => {
    expect(formatElapsed(-100)).toBe("0:00")
    expect(formatElapsed(NaN)).toBe("0:00")
    expect(formatElapsed(Infinity)).toBe("0:00")
  })
})
