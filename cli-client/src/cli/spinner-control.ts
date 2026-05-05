/**
 * Process-wide handle on the agent's `ora` spinner.
 *
 * The agent loop in `agent.ts` owns one long-lived spinner; modal UI
 * (permission prompts, diff previews) needs to pause it before drawing
 * and resume it after, otherwise the spinner repaints on top of the modal.
 *
 * Plumbing the spinner reference everywhere is noise. Module-level state is
 * fine here because there is at most one active spinner at a time.
 */

import type ora from "ora"

type Spinner = ReturnType<typeof ora>

let active: Spinner | null = null
let lastText: string | null = null

export function registerSpinner(spinner: Spinner): void {
  active = spinner
}

export function unregisterSpinner(): void {
  active = null
  lastText = null
}

/** Stop the active spinner so the next console output paints on a clean line. */
export function pauseSpinner(): void {
  if (!active) return
  lastText = active.text
  active.stop()
}

/** Restart the spinner with the same text (or a replacement). */
export function resumeSpinner(text?: string): void {
  if (!active) return
  if (text) active.start(text)
  else if (lastText) active.start(lastText)
  else active.start()
}
