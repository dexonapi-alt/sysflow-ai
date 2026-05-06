import { describe, it, expect } from "vitest"
import { breath, breathAt, cubicOut, elasticOut, linear } from "../easings.js"

describe("easings", () => {
  describe("breath", () => {
    it("hits 0 at t=0 and t=1 (cycle boundaries)", () => {
      expect(breath(0)).toBeCloseTo(0)
      expect(breath(1)).toBeCloseTo(0)
    })

    it("hits 1 at the midpoint t=0.5 (peak)", () => {
      expect(breath(0.5)).toBeCloseTo(1)
    })

    it("symmetric around the midpoint", () => {
      expect(breath(0.25)).toBeCloseTo(breath(0.75))
    })

    it("clamps inputs outside [0,1]", () => {
      // breath(-0.1) should clamp to 0 → returns 0
      expect(breath(-0.5)).toBeCloseTo(0)
      // breath(1.5) should clamp to 1 → returns 0
      expect(breath(1.5)).toBeCloseTo(0)
    })
  })

  describe("cubicOut", () => {
    it("starts at 0, ends at 1", () => {
      expect(cubicOut(0)).toBe(0)
      expect(cubicOut(1)).toBe(1)
    })

    it("is monotonic across the unit interval", () => {
      let prev = -Infinity
      for (let t = 0; t <= 1; t += 0.05) {
        const v = cubicOut(t)
        expect(v).toBeGreaterThanOrEqual(prev)
        prev = v
      }
    })

    it("eases out — early progress is faster than late", () => {
      const earlyDelta = cubicOut(0.1) - cubicOut(0)
      const lateDelta = cubicOut(1) - cubicOut(0.9)
      expect(earlyDelta).toBeGreaterThan(lateDelta)
    })
  })

  describe("elasticOut", () => {
    it("starts at 0, lands at 1", () => {
      expect(elasticOut(0)).toBe(0)
      expect(elasticOut(1)).toBe(1)
    })

    it("overshoots above 1 somewhere in the middle (signature elastic feel)", () => {
      let maxVal = 0
      for (let t = 0; t <= 1; t += 0.01) {
        maxVal = Math.max(maxVal, elasticOut(t))
      }
      expect(maxVal).toBeGreaterThan(1)
    })
  })

  describe("linear", () => {
    it("is the identity in the unit interval", () => {
      expect(linear(0)).toBe(0)
      expect(linear(0.5)).toBe(0.5)
      expect(linear(1)).toBe(1)
    })

    it("clamps outside [0,1]", () => {
      expect(linear(-0.5)).toBe(0)
      expect(linear(1.5)).toBe(1)
    })
  })

  describe("breathAt", () => {
    it("samples the breath curve at the implied phase for a given tempo", () => {
      // 60bpm → 1000ms period. At t=0 we're at the cycle start (value 0).
      expect(breathAt(0, 60)).toBeCloseTo(0)
      // At t=500ms we're at the midpoint of a 60bpm period → peak (value 1).
      expect(breathAt(500, 60)).toBeCloseTo(1)
      // At t=1000ms we've wrapped to the next cycle start (value 0).
      expect(breathAt(1000, 60)).toBeCloseTo(0)
    })

    it("loops seamlessly across cycle boundaries", () => {
      // breathAt(periodMs - 1) and breathAt(0) should be ~equal (same phase).
      const justBefore = breathAt(999, 60)
      const justAfter = breathAt(1000, 60)
      expect(Math.abs(justBefore - justAfter)).toBeLessThan(0.01)
    })

    it("returns 0 for non-positive bpm (defensive)", () => {
      expect(breathAt(500, 0)).toBe(0)
      expect(breathAt(500, -10)).toBe(0)
    })
  })
})
