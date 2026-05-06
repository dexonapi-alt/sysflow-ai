/**
 * Easing curves for the Phase 12 living-CLI animation language.
 *
 * Pure functions over `t ∈ [0, 1]` returning `[0, 1]`. The animation engine
 * (`use-frame.ts`) gives subscribers a normalised time; components shape
 * that into intensity / opacity / position by composing one of these.
 *
 * Design intent (see plan `2026-05-07-phase-12-living-cli-ui.md`):
 *   - `breath` is the core curve. Sin-based, slow, organic. Default for
 *     status-line spinner, badge pulse, evidence-list breathing.
 *   - `cubicOut` for "settle" effects (success ping, single-shot pulses)
 *     where the motion should arrive crisply then ease.
 *   - `elasticOut` for "land" effects (modal slide-in) — small overshoot
 *     reads as composure, not bounce.
 *   - `linear` exists so callers can be explicit about the absence of
 *     easing instead of inlining `(t) => t`.
 *
 * Every function clamps `t` to `[0, 1]` so callers don't have to.
 */

/** Identity. Useful as a default arg when an easing is required by a contract. */
export function linear(t: number): number {
  return clamp01(t)
}

/**
 * Breath curve. Maps `t ∈ [0, 1]` to `[0, 1]` along `(1 - cos(2πt)) / 2`.
 * Hits 0 at t=0 and t=1 (inhale/exhale boundaries) and 1 at t=0.5 (peak).
 *
 * Use this as the underlying shape for "alive" pulses where the motion
 * should feel continuous across cycles — wrapping `t` modulo 1 produces
 * a seamless loop. The curve is steepest at t=0.25 and t=0.75 (the
 * "breathing in / out" phases) and flat at the extremes.
 */
export function breath(t: number): number {
  const tt = clamp01(t)
  return (1 - Math.cos(tt * Math.PI * 2)) / 2
}

/**
 * Cubic out: `1 - (1 - t)^3`. Starts fast, eases to a soft landing.
 * Default curve for single-shot effects (success-pulse, ping flares).
 */
export function cubicOut(t: number): number {
  const tt = clamp01(t)
  const inv = 1 - tt
  return 1 - inv * inv * inv
}

/**
 * Elastic out with a small overshoot. Tuned conservatively (period 0.4,
 * amplitude 1) so the result feels like a confident landing, not a
 * cartoon bounce. Used by modal slide-in.
 */
export function elasticOut(t: number): number {
  const tt = clamp01(t)
  if (tt === 0 || tt === 1) return tt
  const period = 0.4
  return Math.pow(2, -10 * tt) * Math.sin(((tt - period / 4) * (2 * Math.PI)) / period) + 1
}

/**
 * Sample `breath` at the implied phase for a given timestamp + tempo.
 * Convenience for callers that have wall-clock millis and a beats-per-minute
 * value (`theme.tempo.activeBpm` etc.) and don't want to do the modulo
 * themselves.
 */
export function breathAt(nowMs: number, bpm: number): number {
  if (bpm <= 0) return 0
  const periodMs = 60_000 / bpm
  const t = (nowMs % periodMs) / periodMs
  return breath(t)
}

function clamp01(t: number): number {
  if (t < 0) return 0
  if (t > 1) return 1
  return t
}
