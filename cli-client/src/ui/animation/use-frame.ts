/**
 * useFrame — single render-tick hook for the Phase 12 living-CLI animation
 * primitives. Components subscribe via `useFrame((nowMs) => …)` and get a
 * monotonic millisecond timestamp on every tick.
 *
 * Design contract (see plan `2026-05-07-phase-12-living-cli-ui.md`):
 *   - **Single shared scheduler.** All subscribers share one `setInterval`
 *     keyed at `DEFAULT_FPS` so we never fan out to N timers. The scheduler
 *     auto-starts when the first subscriber attaches and auto-stops when
 *     the last one detaches. No global "engine" boot needed.
 *   - **Motion-disabled mode emits exactly one tick** so the subscriber's
 *     callback runs once with the current time (lets `<Breath>` / `<Pulse>`
 *     render their child at a "settled" frame instead of disappearing) but
 *     never schedules a follow-up. Lets `--no-motion` produce a static UI
 *     without the components needing a dual code path.
 *   - **Stable identity contract on the callback.** The hook stores the
 *     latest callback in a ref so the scheduler doesn't have to re-bind
 *     when the parent re-renders with a new closure. Subscribers don't
 *     need `useCallback` to participate.
 *   - **Frame budget is a hint, not a guarantee.** If the host is slow
 *     (Ink reconciliation backed up, terminal write blocked over SSH),
 *     ticks slip — we don't try to "catch up" with a burst. Animations
 *     designed against `nowMs` (not tick count) tolerate this naturally.
 */

import { useEffect, useRef } from "react"
import { isMotionEnabled, onMotionChange } from "../state/motion.js"

export const DEFAULT_FPS = 30
export const FRAME_INTERVAL_MS = Math.round(1000 / DEFAULT_FPS)

/**
 * Stage 1 of plan `2026-05-18-ui-ux-polish-and-action-aware-spinner.md`.
 *
 * Resize-pause window: after a `process.stdout.on("resize")` event fires,
 * the pump skips ticks for this many ms. Closes the user-reported
 * minimize-during-summary scroll-storm bug — on terminal restore the
 * resize event fires once (or several times in close succession), and
 * during that window any per-frame setState would compound into a burst
 * of VT100 sequences that Ink can't reconcile cleanly. Skipping the
 * pump entirely for ~150ms lets Ink's own resize-handler complete its
 * full re-render before per-frame work resumes.
 *
 * Tuned: 150ms is long enough to cover the typical resize-flurry window
 * on Windows Terminal / iTerm2 / GNOME Terminal, short enough that the
 * human eye won't notice the spinner glyph freezing (max 4-5 frames at
 * 30 fps). Operators can tune via the quality.typewriter_pause_during_resize_ms
 * flag (Stage 6).
 */
export const RESIZE_PAUSE_MS = 150

/**
 * Frame callback. Returning `false` signals "I'm done — unsubscribe me
 * from the pump." Returning anything else (undefined, true, etc.) keeps
 * the subscription. This lets one-shot animations (e.g. `<Typewriter>`
 * once the reveal completes) detach themselves WITHOUT the component
 * having to handle unsubscribe-via-effect-cleanup, which was the root
 * cause of the original scroll storm: components stayed subscribed after
 * their work was done, accumulating per-frame setState calls that turned
 * into VT100 burst on resize.
 */
type FrameCallback = (nowMs: number) => boolean | void

const subscribers = new Set<FrameCallback>()
let timer: ReturnType<typeof setInterval> | null = null
let pausedUntilDateMs = 0

/**
 * Pause-window check. Uses `Date.now()` rather than `nowMs()` /
 * `performance.now()` because the pause is a pure wall-clock concern
 * (we don't need monotonic timing here — NTP-correction risk is
 * acceptable for a 150ms window) AND because `Date.now()` is
 * consistently shimmed by `vi.useFakeTimers()` + `vi.setSystemTime()`,
 * which lets the resize-pause tests advance time deterministically
 * without firing the setInterval pump as a side-effect.
 */
function isPausedNow(): boolean {
  return Date.now() < pausedUntilDateMs
}

function pump(): void {
  // Stage 1: skip ticks during the resize pause window. Subscribers stay
  // attached; the pump just doesn't fire their callbacks. Resumes
  // automatically on the next tick after the window closes.
  if (isPausedNow()) return
  const now = nowMs()
  // Collect detachments OUTSIDE the iteration so Set mutation doesn't
  // disrupt the loop. Pump processes the set as-of-this-tick; any
  // callbacks added DURING the pump fire on the next tick (standard
  // single-shared-scheduler semantics).
  const toDetach: FrameCallback[] = []
  for (const fn of subscribers) {
    try {
      const result = fn(now)
      if (result === false) toDetach.push(fn)
    } catch {
      // One bad callback shouldn't kill the loop. Detach it so a
      // persistently-throwing subscriber doesn't burn cycles forever.
      toDetach.push(fn)
    }
  }
  for (const fn of toDetach) subscribers.delete(fn)
  if (subscribers.size === 0) stop()
}

/**
 * Stage 1: install the SIGWINCH listener exactly once per process. The
 * listener flips the pause window forward by RESIZE_PAUSE_MS on every
 * fire (so a rapid burst of resize events from terminal minimize/restore
 * extends the pause cleanly without compounding).
 *
 * Idempotent — safe to call from any subscribeFrame() entrypoint.
 */
let resizeListenerInstalled = false
function ensureResizeListener(): void {
  if (resizeListenerInstalled) return
  if (typeof process === "undefined" || !process.stdout || typeof process.stdout.on !== "function") return
  resizeListenerInstalled = true
  process.stdout.on("resize", () => {
    pausedUntilDateMs = Date.now() + RESIZE_PAUSE_MS
    _scrollGlitchPauseFiredThisRun += 1
  })
}

// ─── Stage 6 of plan 2026-05-18-ui-ux-polish-and-action-aware-spinner.md ───
//
// Per-run counter for "how many times the resize-pause window fired
// this run". Diagnostic for Stage 1's load-bearing fix — if this
// counter is consistently > 0 on runs where users report glitches,
// the debounce is firing as designed. Zero is the common case (no
// resize events) and that's fine.
//
// Module-scoped because the resize listener (above) is also module-
// scoped; agent.ts reads + resets via the exported helpers.

let _scrollGlitchPauseFiredThisRun = 0

export function getScrollGlitchPauseFiredCount(): number {
  return _scrollGlitchPauseFiredThisRun
}

export function resetScrollGlitchPauseFiredCount(): void {
  _scrollGlitchPauseFiredThisRun = 0
}

function start(): void {
  if (timer != null) return
  if (!isMotionEnabled()) return
  ensureResizeListener()
  timer = setInterval(pump, FRAME_INTERVAL_MS)
  // Don't keep the Node process alive just to drive the spinner.
  if (typeof timer === "object" && timer != null && "unref" in timer && typeof (timer as { unref: unknown }).unref === "function") {
    (timer as { unref: () => void }).unref()
  }
}

function stop(): void {
  if (timer == null) return
  clearInterval(timer)
  timer = null
}

/**
 * Whenever the motion store flips, sync the scheduler so we don't keep
 * ticking after `--no-motion` is engaged at runtime. Lazy-registered on
 * the first `subscribeFrame` call (and re-registered if motion was
 * reset by a test) so the listener survives `_resetForTests` of either
 * module without leaking subscriptions across tests.
 */
let motionUnsubscribe: (() => void) | null = null
function ensureMotionListener(): void {
  if (motionUnsubscribe != null) return
  motionUnsubscribe = onMotionChange((enabled) => {
    if (!enabled) stop()
    else if (subscribers.size > 0) start()
  })
}

/**
 * React hook: invoke `cb` on every frame tick. The callback receives a
 * monotonic millisecond timestamp suitable for shaping into easing curves
 * (see `easings.ts: breathAt`).
 *
 * Component lifecycle handles auto-pause: when the last subscriber
 * unmounts, the shared scheduler stops; when a new one mounts, it starts.
 *
 * In motion-disabled mode the callback fires exactly once with the
 * current time, then never again — `<Breath>` etc. render a static
 * "settled" frame.
 */
export function useFrame(cb: FrameCallback): void {
  const ref = useRef<FrameCallback>(cb)
  ref.current = cb

  useEffect(() => {
    // Stage 1: propagate the user callback's return value so a `false`
    // return triggers self-unsubscription via the pump's detach loop.
    // The wrapper keeps a stable identity across renders (the ref shim
    // handles closure freshness).
    const wrapped: FrameCallback = (t) => ref.current(t)

    if (!isMotionEnabled()) {
      // One settled tick so the component can render its baseline pose,
      // then we're done. No subscription registered → no scheduler load.
      wrapped(nowMs())
      return
    }

    ensureMotionListener()
    subscribers.add(wrapped)
    start()
    return () => {
      subscribers.delete(wrapped)
      if (subscribers.size === 0) stop()
    }
  }, [])
}

/**
 * Subscribe outside of React (e.g. a non-component utility that wants to
 * read the tick). Returns an unsubscribe function. Same auto-pause /
 * motion-disabled rules apply.
 */
export function subscribeFrame(cb: FrameCallback): () => void {
  if (!isMotionEnabled()) {
    cb(nowMs())
    return () => { /* noop */ }
  }
  ensureMotionListener()
  subscribers.add(cb)
  start()
  return () => {
    subscribers.delete(cb)
    if (subscribers.size === 0) stop()
  }
}

/** Test-only: how many active subscribers + whether the timer is running. */
export function _internals(): { subscribers: number; timerRunning: boolean; pausedUntilDateMs: number } {
  return { subscribers: subscribers.size, timerRunning: timer != null, pausedUntilDateMs }
}

/** Test-only: drop every subscription, stop the timer, and clear the
 *  motion-listener registration so the next subscribeFrame re-registers
 *  it (in case the motion store was also reset between tests). */
export function _resetForTests(): void {
  subscribers.clear()
  stop()
  pausedUntilDateMs = 0
  _scrollGlitchPauseFiredThisRun = 0
  if (motionUnsubscribe) {
    motionUnsubscribe()
    motionUnsubscribe = null
  }
}

/**
 * Test-only: simulate a resize event by extending the pause window
 * directly. Production code never calls this — the real path is
 * `process.stdout.on("resize")` → ensureResizeListener's handler.
 */
export function _simulateResizeForTests(): void {
  pausedUntilDateMs = Date.now() + RESIZE_PAUSE_MS
}

/**
 * Test-only: run the pump once synchronously. Production code drives
 * the pump via setInterval; tests want to assert behaviour without
 * waiting on real time.
 */
export function _pumpOnceForTests(): void {
  pump()
}

/**
 * Monotonic milliseconds. `performance.now()` when available (avoids
 * wall-clock jumps from NTP), `Date.now()` otherwise. Exported so tests
 * can stub it.
 */
export function nowMs(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now()
  }
  return Date.now()
}
