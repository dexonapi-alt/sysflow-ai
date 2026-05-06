import { describe, it, expect } from "vitest"
import {
  computeBreathColor,
  computePulseColor,
  computeShimmerColors,
  computeFadeColor,
  computeTypewriterCount,
} from "../index.js"

const HEX = /^#[0-9a-f]{6}$/
const FROM = "#1a1a1a"
const TO = "#7C6FFF"

// RGB euclidean distance for "close enough" assertions.
function dist(a: string, b: string): number {
  const ah = a.replace("#", "")
  const bh = b.replace("#", "")
  const ar = parseInt(ah.slice(0, 2), 16), ag = parseInt(ah.slice(2, 4), 16), ab = parseInt(ah.slice(4, 6), 16)
  const br = parseInt(bh.slice(0, 2), 16), bg = parseInt(bh.slice(2, 4), 16), bb = parseInt(bh.slice(4, 6), 16)
  return Math.sqrt(Math.pow(ar - br, 2) + Math.pow(ag - bg, 2) + Math.pow(ab - bb, 2))
}

describe("computeBreathColor", () => {
  it("hits the trough color at the cycle start (t=0)", () => {
    // breath(0) = 0 → lerp(from, to, 0) = from
    expect(dist(computeBreathColor(0, 60, FROM, TO), FROM)).toBeLessThan(8)
  })

  it("hits the peak color at the cycle midpoint (500ms for 60bpm)", () => {
    // breath(0.5) = 1 → lerp(from, to, 1) = to
    expect(dist(computeBreathColor(500, 60, FROM, TO), TO)).toBeLessThan(8)
  })

  it("returns to the trough at the cycle end (1000ms for 60bpm)", () => {
    expect(dist(computeBreathColor(1000, 60, FROM, TO), FROM)).toBeLessThan(8)
  })

  it("respects the bpm — 120bpm completes a cycle in 500ms", () => {
    // At t=125ms with 120bpm, we're at quarter-cycle = breath(0.25) ≈ 0.5
    const quarter = computeBreathColor(125, 120, FROM, TO)
    expect(quarter).toMatch(HEX)
    // Quarter-cycle should be roughly halfway between from and to.
    expect(dist(quarter, FROM)).toBeGreaterThan(dist(computeBreathColor(0, 120, FROM, TO), FROM))
    expect(dist(quarter, TO)).toBeGreaterThan(dist(computeBreathColor(250, 120, FROM, TO), TO))
  })

  it("output is always a valid hex string", () => {
    for (let t = 0; t <= 1000; t += 50) {
      expect(computeBreathColor(t, 60, FROM, TO)).toMatch(HEX)
    }
  })
})

describe("computePulseColor", () => {
  it("returns flash color at t=0 (the moment of trigger)", () => {
    expect(dist(computePulseColor(0, 600, "#E74C3C", "#7F8C8D"), "#E74C3C")).toBeLessThan(8)
  })

  it("returns settled color past the duration", () => {
    expect(dist(computePulseColor(700, 600, "#E74C3C", "#7F8C8D"), "#7F8C8D")).toBeLessThan(8)
  })

  it("returns flash color for negative elapsed (pre-trigger guard)", () => {
    expect(dist(computePulseColor(-50, 600, "#E74C3C", "#7F8C8D"), "#E74C3C")).toBeLessThan(8)
  })

  it("monotonically approaches the settled color across the decay", () => {
    let prevDist = Infinity
    for (let t = 0; t <= 600; t += 30) {
      const c = computePulseColor(t, 600, "#E74C3C", "#7F8C8D")
      const d = dist(c, "#7F8C8D")
      expect(d).toBeLessThanOrEqual(prevDist + 1) // tiny float wiggle ok
      prevDist = d
    }
  })

  it("eases out — early decay is faster than late decay (cubicOut signature)", () => {
    // distance covered in first half should be > second half
    const start = computePulseColor(0, 600, "#E74C3C", "#7F8C8D")
    const mid = computePulseColor(300, 600, "#E74C3C", "#7F8C8D")
    const end = computePulseColor(600, 600, "#E74C3C", "#7F8C8D")
    expect(dist(start, mid)).toBeGreaterThan(dist(mid, end))
  })
})

describe("computeShimmerColors", () => {
  it("returns one color per character", () => {
    const out = computeShimmerColors("hello", 0, 1500, 3, "#1a1a1a", "#7C6FFF")
    expect(out).toHaveLength(5)
    out.forEach((c) => expect(c).toMatch(HEX))
  })

  it("returns empty array for empty text", () => {
    expect(computeShimmerColors("", 0, 1500, 3, "#1a1a1a", "#7C6FFF")).toEqual([])
  })

  it("highlight position sweeps across the text over a full period", () => {
    const text = "abcdefghij"
    // At t=0 the cursor is at column 0 → first char brightest.
    const a = computeShimmerColors(text, 0, 1500, 3, "#1a1a1a", "#7C6FFF")
    // At t=750 (half-period) the cursor is at column 5 → middle char brightest.
    const b = computeShimmerColors(text, 750, 1500, 3, "#1a1a1a", "#7C6FFF")

    // Find the brightest column in each (closest to highlight).
    const idxA = brightest(a, "#7C6FFF")
    const idxB = brightest(b, "#7C6FFF")

    expect(idxA).toBeLessThan(idxB)
  })

  it("a wider highlight lights more characters at peak", () => {
    const text = "abcdefghij"
    const narrow = computeShimmerColors(text, 0, 1500, 1, "#1a1a1a", "#7C6FFF")
    const wide = computeShimmerColors(text, 0, 1500, 5, "#1a1a1a", "#7C6FFF")
    // "Brightness" = distance from the dark base color. The further a
    // character has been lerped toward the highlight, the larger its
    // distance from base. A wider highlight illuminates more characters
    // each at a measurable fraction of full intensity, so the SUM should
    // be larger than the narrow case (where only ~2 chars get any lift).
    const narrowBrightness = narrow.reduce((s, c) => s + dist(c, "#1a1a1a"), 0)
    const wideBrightness = wide.reduce((s, c) => s + dist(c, "#1a1a1a"), 0)
    expect(wideBrightness).toBeGreaterThan(narrowBrightness)
  })
})

function brightest(colors: string[], target: string): number {
  let best = 0
  let bestDist = Infinity
  for (let i = 0; i < colors.length; i++) {
    const d = dist(colors[i], target)
    if (d < bestDist) { bestDist = d; best = i }
  }
  return best
}

describe("computeFadeColor", () => {
  it("fade-in starts at muted, ends at color", () => {
    const start = computeFadeColor("in", 0, 300, "#7C6FFF", "#7F8C8D")
    const end = computeFadeColor("in", 300, 300, "#7C6FFF", "#7F8C8D")
    expect(dist(start, "#7F8C8D")).toBeLessThan(8)
    expect(dist(end, "#7C6FFF")).toBeLessThan(8)
  })

  it("fade-out starts at color, ends at muted", () => {
    const start = computeFadeColor("out", 0, 300, "#7C6FFF", "#7F8C8D")
    const end = computeFadeColor("out", 300, 300, "#7C6FFF", "#7F8C8D")
    expect(dist(start, "#7C6FFF")).toBeLessThan(8)
    expect(dist(end, "#7F8C8D")).toBeLessThan(8)
  })

  it("clamps past the duration", () => {
    expect(dist(computeFadeColor("in", 1_000, 300, "#7C6FFF", "#7F8C8D"), "#7C6FFF")).toBeLessThan(8)
    expect(dist(computeFadeColor("out", 1_000, 300, "#7C6FFF", "#7F8C8D"), "#7F8C8D")).toBeLessThan(8)
  })

  it("clamps for negative elapsed", () => {
    expect(dist(computeFadeColor("in", -50, 300, "#7C6FFF", "#7F8C8D"), "#7F8C8D")).toBeLessThan(8)
    expect(dist(computeFadeColor("out", -50, 300, "#7C6FFF", "#7F8C8D"), "#7C6FFF")).toBeLessThan(8)
  })
})

describe("computeTypewriterCount", () => {
  it("returns 0 chars at t=0", () => {
    expect(computeTypewriterCount("hello", 0, 250)).toBe(0)
  })

  it("returns full length once budget covers the whole string", () => {
    // At 250wpm with 5 chars/word → 24 chars/sec → "hello" (5 chars) ≈ 208ms.
    expect(computeTypewriterCount("hello", 1_000, 250)).toBe(5)
  })

  it("monotonically increases over time", () => {
    const text = "the quick brown fox"
    let prev = -1
    for (let t = 0; t <= 2_000; t += 50) {
      const c = computeTypewriterCount(text, t, 250)
      expect(c).toBeGreaterThanOrEqual(prev)
      prev = c
    }
  })

  it("pauses longer at periods than at letters", () => {
    // "ab. cd" — a period after 'b' should add a much longer pause than
    // a letter would. Compare reveal counts at the same time for two
    // strings of the same length, one with a period, one without.
    const withPeriod = "ab. cd"
    const without = "abcd cd"
    // Sample at a time that's just past where "abc" would be revealed
    // in the no-punctuation string (~125ms at 250wpm).
    const c1 = computeTypewriterCount(withPeriod, 200, 250)
    const c2 = computeTypewriterCount(without, 200, 250)
    expect(c1).toBeLessThan(c2)
  })

  it("pauses longer at commas than at letters", () => {
    const withComma = "ab, cd"
    const without = "abcd cd"
    const c1 = computeTypewriterCount(withComma, 200, 250)
    const c2 = computeTypewriterCount(without, 200, 250)
    expect(c1).toBeLessThan(c2)
  })

  it("returns 0 for empty text regardless of time", () => {
    expect(computeTypewriterCount("", 1_000, 250)).toBe(0)
  })

  it("scales with wpm — faster wpm reveals more in the same time", () => {
    const text = "the quick brown fox jumps"
    const slow = computeTypewriterCount(text, 500, 100)
    const fast = computeTypewriterCount(text, 500, 500)
    expect(fast).toBeGreaterThan(slow)
  })
})
