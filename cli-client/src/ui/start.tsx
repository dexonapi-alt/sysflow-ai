import * as React from "react"
import { render } from "ink"
import { App } from "./App.js"

/**
 * Mount the Ink UI. Returns once Ink unmounts (Ctrl-C or exit). Kept in a
 * separate `.tsx` file so `index.ts` (plain TS) doesn't need to compile JSX.
 */
export async function startInkUi(): Promise<void> {
  const instance = render(<App />)
  await instance.waitUntilExit()
}
