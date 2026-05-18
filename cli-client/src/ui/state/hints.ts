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
 *  agent-events reducer:
 *    - `permission_modal` — askPermission is active (Phase 12 raw-TTY modal).
 *    - `offcourse_modal`  — askOffCourse is active (Phase 11 raw-TTY modal).
 *    - `working`          — a spinner is in flight (model call / tool dispatch).
 *    - `idle`             — nothing's happening; the prompt is the user's.
 *
 *  Stage 5 of plan 2026-05-18-ui-ux-polish-and-action-aware-spinner.md
 *  (audit issue #5) added the two modal states. Pre-Stage-5 the hint
 *  row stayed on `idle` during modals, telling the user about keys
 *  (`↑ history`, `/ commands`) that did nothing while the modal had
 *  control of stdin. */
export type HintState = "idle" | "working" | "permission_modal" | "offcourse_modal"

/** The exposed keystrokes per state. Each entry is a short label that
 *  reads as the affordance — `↑ history`, not `press up to navigate
 *  history`. Two-or-three keys per state keeps the row scannable.
 *
 *  Order is intentional: most-used first so the eye lands on it. */
export const HINT_TABLE: Record<HintState, readonly string[]> = {
  idle:             ["↑ history", "/ commands", "tab complete", "ctrl+c exit"],
  working:          ["ctrl+c cancel"],
  permission_modal: ["[a] allow once", "[A] allow always", "[d] deny once", "[D] deny always"],
  offcourse_modal:  ["[c] continue", "[b] backtrack", "[r] redirect", "[q] cancel"],
}

/** Pure: pick the hints for a given state. Falls back to `idle` if a
 *  caller passes a state we haven't defined yet — defensive against
 *  future event-bus additions outpacing the table. */
export function pickHints(state: HintState | string): readonly string[] {
  if (state === "permission_modal") return HINT_TABLE.permission_modal
  if (state === "offcourse_modal") return HINT_TABLE.offcourse_modal
  if (state === "working") return HINT_TABLE.working
  return HINT_TABLE.idle
}

/** Pure: render hints as a single-line muted string. The separator is
 *  the same `  ·  ` the Header uses for its identity cells, so the
 *  bottom row reads as part of the same vocabulary. */
export function formatHints(hints: readonly string[]): string {
  return hints.join("  ·  ")
}
