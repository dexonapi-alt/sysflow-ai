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

type FrameCallback = (nowMs: number) => void

const subscribers = new Set<FrameCallback>()
let timer: ReturnType<typeof setInterval> | null = null

function pump(): void {
  const now = nowMs()
  for (const fn of subscribers) {
    try { fn(now) } catch { /* one bad callback shouldn't kill the loop */ }
  }
}

function start(): void {
  if (timer != null) return
  if (!isMotionEnabled()) return
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
export function _internals(): { subscribers: number; timerRunning: boolean } {
  return { subscribers: subscribers.size, timerRunning: timer != null }
}

/** Test-only: drop every subscription, stop the timer, and clear the
 *  motion-listener registration so the next subscribeFrame re-registers
 *  it (in case the motion store was also reset between tests). */
export function _resetForTests(): void {
  subscribers.clear()
  stop()
  if (motionUnsubscribe) {
    motionUnsubscribe()
    motionUnsubscribe = null
  }
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
