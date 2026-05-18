import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import {
  subscribeFrame,
  _internals,
  _resetForTests,
  _simulateResizeForTests,
  _pumpOnceForTests,
  FRAME_INTERVAL_MS,
  RESIZE_PAUSE_MS,
} from "../use-frame.js"
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
    subscribeFrame((t) => { samples.push(t) })
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

// ─── Stage 1 of plan 2026-05-18-ui-ux-polish-and-action-aware-spinner.md ───

describe("use-frame: return-false detach", () => {
  beforeEach(() => {
    _resetMotion()
    _resetForTests()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    _resetForTests()
    _resetMotion()
  })

  it("detaches a subscriber that returns false on the next pump", () => {
    let fireCount = 0
    subscribeFrame(() => {
      fireCount += 1
      if (fireCount >= 2) return false // detach after the second tick
    })
    expect(_internals().subscribers).toBe(1)
    _pumpOnceForTests()
    expect(_internals().subscribers).toBe(1)
    _pumpOnceForTests()
    // After the second pump, the callback returned false → detached.
    expect(_internals().subscribers).toBe(0)
  })

  it("keeps subscribers that return undefined / void", () => {
    let count = 0
    subscribeFrame(() => { count += 1 })
    _pumpOnceForTests()
    _pumpOnceForTests()
    _pumpOnceForTests()
    expect(count).toBe(3)
    expect(_internals().subscribers).toBe(1)
  })

  it("auto-stops the timer when the last subscriber self-detaches", () => {
    subscribeFrame(() => false)
    expect(_internals().timerRunning).toBe(true)
    _pumpOnceForTests()
    expect(_internals().subscribers).toBe(0)
    expect(_internals().timerRunning).toBe(false)
  })

  it("a throwing subscriber gets detached so it doesn't burn cycles forever", () => {
    let goodCount = 0
    subscribeFrame(() => { throw new Error("persistent boom") })
    subscribeFrame(() => { goodCount += 1 })
    expect(_internals().subscribers).toBe(2)
    _pumpOnceForTests()
    // Bad subscriber detached; good one stays.
    expect(_internals().subscribers).toBe(1)
    expect(goodCount).toBe(1)
    _pumpOnceForTests()
    expect(goodCount).toBe(2)
  })
})

describe("use-frame: resize-pause window", () => {
  beforeEach(() => {
    _resetMotion()
    _resetForTests()
    // The pause-check uses `Date.now()` (not nowMs/performance.now)
    // precisely so vi.useFakeTimers's default shim shifts the pause
    // window with `vi.setSystemTime` / `vi.advanceTimersByTime`.
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    _resetForTests()
    _resetMotion()
  })

  it("skips ticks during the resize pause window", () => {
    let count = 0
    subscribeFrame(() => { count += 1 })
    _pumpOnceForTests() // baseline pump fires
    expect(count).toBe(1)

    _simulateResizeForTests()
    // While paused, pumps no-op.
    _pumpOnceForTests()
    _pumpOnceForTests()
    expect(count).toBe(1)
  })

  it("resumes ticks after the pause window expires", () => {
    let count = 0
    subscribeFrame(() => { count += 1 })
    _simulateResizeForTests()
    _pumpOnceForTests() // paused — no-op
    expect(count).toBe(0)

    // Advance past the pause window.
    vi.advanceTimersByTime(RESIZE_PAUSE_MS + 10)
    _pumpOnceForTests()
    expect(count).toBe(1)
  })

  it("subsequent resizes extend the pause window forward (handles rapid bursts)", () => {
    // Set a deterministic baseline; use setSystemTime to shift the
    // clock WITHOUT firing pending setInterval pumps along the way,
    // so we assert pause-extension semantics independently of the
    // pump cadence.
    const startTime = Date.now()
    let count = 0
    subscribeFrame(() => { count += 1 })

    _simulateResizeForTests() // pausedUntilDateMs = Date.now() + 150
    vi.setSystemTime(startTime + 100)
    _pumpOnceForTests()
    expect(count).toBe(0) // 100ms elapsed, still inside the 150ms window

    _simulateResizeForTests() // extends window to Date.now() + 150 again
    vi.setSystemTime(startTime + 200) // 100ms past the second resize
    _pumpOnceForTests()
    expect(count).toBe(0) // still paused due to extension (window=150ms from t=200, ends at t=350)

    vi.setSystemTime(startTime + 200 + RESIZE_PAUSE_MS + 10)
    _pumpOnceForTests()
    expect(count).toBe(1)
  })

  it("pump skip during pause does NOT detach subscribers (they stay attached)", () => {
    subscribeFrame(() => { /* noop */ })
    expect(_internals().subscribers).toBe(1)
    _simulateResizeForTests()
    _pumpOnceForTests()
    _pumpOnceForTests()
    _pumpOnceForTests()
    // Still subscribed; we just skipped the work.
    expect(_internals().subscribers).toBe(1)
  })
})
