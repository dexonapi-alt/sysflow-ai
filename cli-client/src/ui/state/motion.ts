/**
 * Motion store — single boolean controlling whether animation primitives
 * are allowed to schedule frame ticks. Module-singleton (not React context)
 * because plenty of code paths read it from outside the React tree:
 * `use-frame` short-circuits its setInterval, `Typewriter` skips the reveal
 * and renders the full string immediately, the modal animations collapse to
 * static frames, etc.
 *
 * Read precedence at boot (`cli-client/src/index.ts` calls `applyEnv()`):
 *   1. CLI flag `--no-motion`
 *   2. env `SYS_NO_MOTION=1`
 *   3. default: enabled
 *
 * Subscribe API exists so a future `<MotionProvider>` (Phase 12 Stage 2)
 * can re-render its subtree when the user toggles motion at runtime —
 * v1 only flips at boot, but the hook is wired so we don't need a second
 * pass when runtime toggling lands.
 */

type Listener = (enabled: boolean) => void

let enabled = true
const listeners = new Set<Listener>()

/** True when components may schedule frame ticks / typewriter pauses / etc. */
export function isMotionEnabled(): boolean {
  return enabled
}

/** Imperatively flip the store. Notifies subscribers if the value changes. */
export function setMotionEnabled(next: boolean): void {
  if (next === enabled) return
  enabled = next
  for (const fn of listeners) fn(enabled)
}

/** Subscribe to changes; returns an unsubscribe fn. Listener fires immediately
 *  with the current value so callers can initialise without an extra read. */
export function onMotionChange(fn: Listener): () => void {
  listeners.add(fn)
  fn(enabled)
  return () => { listeners.delete(fn) }
}

/**
 * Read CLI args + env once at startup and apply to the store.
 * Idempotent — safe to call multiple times. Pulls argv off `process.argv`
 * so callers don't have to thread it.
 */
export function applyEnv(argv: readonly string[] = process.argv): void {
  if (argv.includes("--no-motion")) {
    setMotionEnabled(false)
    return
  }
  if (process.env.SYS_NO_MOTION === "1" || (process.env.SYS_NO_MOTION ?? "").toLowerCase() === "true") {
    setMotionEnabled(false)
    return
  }
  setMotionEnabled(true)
}

/** Test-only: reset to default (enabled) and clear listeners. */
export function _resetForTests(): void {
  enabled = true
  listeners.clear()
}
