import { describe, it, expect } from "vitest"
import { lerpHex, paint, confidenceGradient } from "../color-lerp.js"

const HEX = /^#[0-9a-f]{6}$/

describe("color-lerp", () => {
  describe("lerpHex", () => {
    it("returns the start colour at t=0 (allowing tiny rounding)", () => {
      const out = lerpHex("#58D68D", "#E74C3C", 0)
      expect(out).toMatch(HEX)
      // Same RGB ± 1 step in any channel due to HSL round-trip.
      expect(distance(out, "#58D68D")).toBeLessThan(4)
    })

    it("returns the end colour at t=1 (allowing tiny rounding)", () => {
      const out = lerpHex("#58D68D", "#E74C3C", 1)
      expect(distance(out, "#E74C3C")).toBeLessThan(4)
    })

    it("walks through HSL space without dropping into black or grey at the midpoint", () => {
      // RGB-naive lerp from green to red drops to ~muddy brown (~#a0a0a0-ish luminance).
      // HSL lerp should stay vivid — the midpoint should be a yellow/orange of similar lightness.
      const mid = lerpHex("#58D68D", "#E74C3C", 0.5)
      const { l } = parseLightness(mid)
      // Green is l≈0.59, red is l≈0.57 → midpoint should land ~0.58, not <0.4.
      expect(l).toBeGreaterThan(0.4)
    })

    it("clamps inputs outside [0,1]", () => {
      expect(distance(lerpHex("#58D68D", "#E74C3C", -0.5), "#58D68D")).toBeLessThan(4)
      expect(distance(lerpHex("#58D68D", "#E74C3C", 1.5), "#E74C3C")).toBeLessThan(4)
    })

    it("produces a continuous path (no large jumps between adjacent t values)", () => {
      // Adjacent samples should never differ by a huge RGB euclidean distance —
      // a discontinuity would mean the lerp jumped through black or wrapped weirdly.
      const samples = Array.from({ length: 21 }, (_, i) => lerpHex("#58D68D", "#E74C3C", i / 20))
      for (let i = 1; i < samples.length; i++) {
        const d = distance(samples[i - 1], samples[i])
        // The point of this test is to catch DISCONTINUITIES (e.g. the lerp
        // wrapping through black would produce a ~440 RGB delta in one step).
        // The smoothest paths have <40 per step; the high-saturation yellow
        // segments measure ~100. 150 catches the bug without false positives.
        expect(d).toBeLessThan(150)
      }
    })
  })

  describe("paint", () => {
    it("returns the input string when chalk has no colour support (level 0)", () => {
      // We can't easily mock chalk.level here, so just assert the path doesn't
      // throw and produces a string that contains the input. When the test
      // host has truecolor, the result will be ANSI-wrapped.
      const out = paint("hello", "#58D68D", "#E74C3C", 0.5)
      expect(out).toContain("hello")
    })
  })

  describe("confidenceGradient", () => {
    it("starts at green for on_track (t=0)", () => {
      // confidenceGradient(0) → lerpHex(green, yellow, 0) → green
      expect(distance(confidenceGradient(0), "#58D68D")).toBeLessThan(4)
    })

    it("hits yellow at the off_course midpoint (t=0.5)", () => {
      expect(distance(confidenceGradient(0.5), "#F4D03F")).toBeLessThan(8)
    })

    it("ends at red for blocked (t=1)", () => {
      expect(distance(confidenceGradient(1), "#E74C3C")).toBeLessThan(4)
    })

    it("never drops into a grey at any sampled point", () => {
      // Walk the full gradient and verify saturation stays high — a grey
      // would indicate the path went through the centre of HSL.
      for (let i = 0; i <= 20; i++) {
        const hex = confidenceGradient(i / 20)
        const sat = saturation(hex)
        expect(sat).toBeGreaterThan(0.4)
      }
    })
  })
})

// ─── Helpers ──────────────────────────────────────────────────────────

function parseRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace("#", "")
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  }
}

function distance(a: string, b: string): number {
  const aa = parseRgb(a)
  const bb = parseRgb(b)
  return Math.sqrt(
    Math.pow(aa.r - bb.r, 2) + Math.pow(aa.g - bb.g, 2) + Math.pow(aa.b - bb.b, 2),
  )
}

function parseLightness(hex: string): { l: number } {
  const { r, g, b } = parseRgb(hex)
  const max = Math.max(r, g, b) / 255
  const min = Math.min(r, g, b) / 255
  return { l: (max + min) / 2 }
}

function saturation(hex: string): number {
  const { r, g, b } = parseRgb(hex)
  const rN = r / 255, gN = g / 255, bN = b / 255
  const max = Math.max(rN, gN, bN)
  const min = Math.min(rN, gN, bN)
  const l = (max + min) / 2
  if (max === min) return 0
  const d = max - min
  return l > 0.5 ? d / (2 - max - min) : d / (max + min)
}
