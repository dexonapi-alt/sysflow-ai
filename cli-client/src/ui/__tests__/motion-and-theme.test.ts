import { describe, it, expect, beforeEach, afterEach } from "vitest"
import {
  applyEnv,
  isMotionEnabled,
  onMotionChange,
  setMotionEnabled,
  _resetForTests,
} from "../state/motion.js"
import { awarenessColor, tempo, easing, gradient, spacing } from "../theme.js"

describe("motion store", () => {
  const originalEnv = process.env.SYS_NO_MOTION
  beforeEach(() => {
    _resetForTests()
    delete process.env.SYS_NO_MOTION
  })
  afterEach(() => {
    _resetForTests()
    if (originalEnv === undefined) delete process.env.SYS_NO_MOTION
    else process.env.SYS_NO_MOTION = originalEnv
  })

  it("defaults to enabled", () => {
    expect(isMotionEnabled()).toBe(true)
  })

  it("setMotionEnabled flips the value and notifies subscribers", () => {
    const seen: boolean[] = []
    onMotionChange((v) => seen.push(v))
    // Initial fire on subscribe.
    expect(seen).toEqual([true])
    setMotionEnabled(false)
    expect(seen).toEqual([true, false])
    expect(isMotionEnabled()).toBe(false)
  })

  it("setMotionEnabled is a no-op when value doesn't change", () => {
    const seen: boolean[] = []
    onMotionChange((v) => seen.push(v))
    setMotionEnabled(true)  // already true
    expect(seen).toEqual([true])  // no extra fire
  })

  it("applyEnv recognises --no-motion flag", () => {
    applyEnv(["node", "sys", "--no-motion"])
    expect(isMotionEnabled()).toBe(false)
  })

  it("applyEnv recognises SYS_NO_MOTION=1 env", () => {
    process.env.SYS_NO_MOTION = "1"
    applyEnv(["node", "sys"])
    expect(isMotionEnabled()).toBe(false)
  })

  it("applyEnv recognises SYS_NO_MOTION=true env (case-insensitive)", () => {
    process.env.SYS_NO_MOTION = "TRUE"
    applyEnv(["node", "sys"])
    expect(isMotionEnabled()).toBe(false)
  })

  it("applyEnv defaults to enabled when no flag/env present", () => {
    applyEnv(["node", "sys"])
    expect(isMotionEnabled()).toBe(true)
  })

  it("onMotionChange returns an unsubscribe fn", () => {
    const seen: boolean[] = []
    const unsub = onMotionChange((v) => seen.push(v))
    setMotionEnabled(false)
    unsub()
    setMotionEnabled(true)
    // Only the initial fire + one flip captured; no firing after unsub.
    expect(seen).toEqual([true, false])
  })
})

describe("theme tokens", () => {
  it("exposes Phase 12 tempo at expected bpm values", () => {
    expect(tempo.activeBpm).toBe(60)
    expect(tempo.idleBpm).toBe(20)
    expect(tempo.modalBpm).toBe(40)
    // Tempo ordering invariant: idle < modal < active.
    expect(tempo.idleBpm).toBeLessThan(tempo.modalBpm)
    expect(tempo.modalBpm).toBeLessThan(tempo.activeBpm)
  })

  it("exposes semantic easing names", () => {
    expect(easing.alive).toBe("breath")
    expect(easing.settle).toBe("cubicOut")
    expect(easing.land).toBe("elasticOut")
  })

  it("exposes gradient endpoint pairs as [from, to] tuples", () => {
    expect(gradient.confidenceWarm).toHaveLength(2)
    expect(gradient.confidenceHot).toHaveLength(2)
    // Confidence warm + hot share the yellow midpoint.
    expect(gradient.confidenceWarm[1]).toBe(gradient.confidenceHot[0])
  })

  it("exposes spacing constants in character widths", () => {
    expect(spacing.cardInner).toBeGreaterThan(0)
    expect(spacing.modalInner).toBeGreaterThan(spacing.cardInner)
  })

  describe("awarenessColor accessor", () => {
    it("returns the discrete palette color for each state", () => {
      expect(awarenessColor("on_track")).toMatch(/^#/)
      expect(awarenessColor("off_course")).toMatch(/^#/)
      expect(awarenessColor("blocked")).toMatch(/^#/)
    })

    it("returns distinct colors for each state", () => {
      const a = awarenessColor("on_track")
      const b = awarenessColor("off_course")
      const c = awarenessColor("blocked")
      expect(new Set([a, b, c]).size).toBe(3)
    })
  })
})
