import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { subscribeFrame, _internals, _resetForTests, FRAME_INTERVAL_MS } from "../use-frame.js"
import { setMotionEnabled, _resetForTests as _resetMotion } from "../../state/motion.js"

describe("use-frame scheduler (subscribeFrame outside React)", () => {
  beforeEach(() => {
    _resetMotion()       // motion enabled
    _resetForTests()     // no subscribers, timer stopped
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    _resetForTests()
    _resetMotion()
  })

  it("starts the shared timer when the first subscriber attaches", () => {
    expect(_internals().timerRunning).toBe(false)
    const unsub = subscribeFrame(() => { /* noop */ })
    expect(_internals().timerRunning).toBe(true)
    expect(_internals().subscribers).toBe(1)
    unsub()
  })

  it("auto-stops the timer when the last subscriber detaches", () => {
    const a = subscribeFrame(() => { /* noop */ })
    const b = subscribeFrame(() => { /* noop */ })
    expect(_internals().subscribers).toBe(2)
    a()
    expect(_internals().timerRunning).toBe(true)
    b()
    expect(_internals().timerRunning).toBe(false)
    expect(_internals().subscribers).toBe(0)
  })

  it("invokes every subscriber on each frame tick", () => {
    const a = vi.fn()
    const b = vi.fn()
    subscribeFrame(a)
    subscribeFrame(b)
    vi.advanceTimersByTime(FRAME_INTERVAL_MS * 3)
    // Each subscriber should have been called ~3 times.
    expect(a.mock.calls.length).toBeGreaterThanOrEqual(3)
    expect(b.mock.calls.length).toBe(a.mock.calls.length)
  })

  it("passes a monotonic timestamp as the callback arg", () => {
    const samples: number[] = []
    subscribeFrame((t) => samples.push(t))
    vi.advanceTimersByTime(FRAME_INTERVAL_MS * 4)
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]).toBeGreaterThanOrEqual(samples[i - 1])
    }
  })

  it("isolates one bad subscriber from the rest", () => {
    const good = vi.fn()
    subscribeFrame(() => { throw new Error("boom") })
    subscribeFrame(good)
    vi.advanceTimersByTime(FRAME_INTERVAL_MS * 2)
    expect(good).toHaveBeenCalled()
  })

  it("with motion disabled: emits one settled tick then stops", () => {
    setMotionEnabled(false)
    const cb = vi.fn()
    const unsub = subscribeFrame(cb)
    expect(cb).toHaveBeenCalledTimes(1)
    expect(_internals().subscribers).toBe(0)
    expect(_internals().timerRunning).toBe(false)
    // Advancing the clock should not produce additional ticks.
    vi.advanceTimersByTime(FRAME_INTERVAL_MS * 5)
    expect(cb).toHaveBeenCalledTimes(1)
    unsub()
  })

  it("flipping motion off mid-flight stops further ticks", () => {
    const cb = vi.fn()
    subscribeFrame(cb)
    vi.advanceTimersByTime(FRAME_INTERVAL_MS * 2)
    const callsBeforeFlip = cb.mock.calls.length
    expect(callsBeforeFlip).toBeGreaterThan(0)

    setMotionEnabled(false)
    expect(_internals().timerRunning).toBe(false)
    vi.advanceTimersByTime(FRAME_INTERVAL_MS * 5)
    // No new ticks after motion was disabled.
    expect(cb.mock.calls.length).toBe(callsBeforeFlip)
  })
})
