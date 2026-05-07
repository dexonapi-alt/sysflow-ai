/**
 * Per-state hint table for <InteractiveHints>.
 *
 * The CLI exposes a small set of always-available keystrokes that change
 * meaning depending on what the user is doing right now. Phase 12-13
 * scattered these across components: ChatInput had its own inline `↑
 * history · Tab complete · \↵ newline` line; Header had a wide muted
 * row of slash-command names; the spinner zone had nothing. Phase 14
 * Stage 5 collects them in one always-visible bottom row that updates
 * with the agent's state.
 *
 * The pure helpers exported here are the contract: components consume
 * `pickHints(state)` and the table changes are testable without
 * rendering Ink.
 */

/** Coarse states that drive which hints are relevant. Derived from the
 *  agent-events reducer — `working` whenever a spinner is in flight,
 *  `idle` otherwise. Future stages can add `awaiting_modal` (Phase 11
 *  recovery modal) and `typing` (richer ChatInput integration). */
export type HintState = "idle" | "working"

/** The exposed keystrokes per state. Each entry is a short label that
 *  reads as the affordance — `↑ history`, not `press up to navigate
 *  history`. Two-or-three keys per state keeps the row scannable.
 *
 *  Order is intentional: most-used first so the eye lands on it. */
export const HINT_TABLE: Record<HintState, readonly string[]> = {
  idle:    ["↑ history", "/ commands", "tab complete", "ctrl+c exit"],
  working: ["ctrl+c cancel"],
}

/** Pure: pick the hints for a given state. Falls back to `idle` if a
 *  caller passes a state we haven't defined yet — defensive against
 *  future event-bus additions outpacing the table. */
export function pickHints(state: HintState | string): readonly string[] {
  if (state === "working") return HINT_TABLE.working
  return HINT_TABLE.idle
}

/** Pure: render hints as a single-line muted string. The separator is
 *  the same `  ·  ` the Header uses for its identity cells, so the
 *  bottom row reads as part of the same vocabulary. */
export function formatHints(hints: readonly string[]): string {
  return hints.join("  ·  ")
}
