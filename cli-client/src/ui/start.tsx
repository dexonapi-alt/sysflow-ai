import * as React from "react"
import { render } from "ink"
import { App } from "./App.js"
import { redirectConsoleToInk, restoreConsole } from "../agent/events.js"

/**
 * Mount the Ink UI. Returns once Ink unmounts (Ctrl-C or exit). Kept in a
 * separate `.tsx` file so `index.ts` (plain TS) doesn't need to compile JSX.
 *
 * Phase 13: redirect raw `console.log` / `warn` / `error` through the agent
 * event bus *before* mounting Ink so the agent loop's 100+ existing console
 * calls render as log entries inside `<AgentStream>` instead of stomping
 * over Ink's render zone. Restored on unmount so anything that runs after
 * (telemetry flush, error path) prints normally.
 */
export async function startInkUi(): Promise<void> {
  redirectConsoleToInk()
  try {
    const instance = render(<App />)
    await instance.waitUntilExit()
  } finally {
    restoreConsole()
  }
}
