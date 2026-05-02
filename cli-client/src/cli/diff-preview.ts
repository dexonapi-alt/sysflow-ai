/**
 * Tab-to-expand diff preview. Module-level state is intentional — there is at
 * most one active run with one pending diff at a time, and lifting it into the
 * controller would just push the state around. Cleanup is explicit.
 */

import type ora from "ora"
import { getLastDiff, formatDiffColored } from "../agent/diff.js"
import { BOX, colors } from "./render.js"

let pendingDiffRunId: string | null = null
let diffExpandEnabled = false

export function enableDiffExpand(runId: string): void {
  pendingDiffRunId = runId
  diffExpandEnabled = true
}

export function disableDiffExpand(): void {
  diffExpandEnabled = false
  pendingDiffRunId = null
}

/**
 * Start listening for Tab keypress to expand diffs. Returns a cleanup function.
 */
export function startDiffKeyListener(spinner: ReturnType<typeof ora>): () => void {
  if (!process.stdin.isTTY) return () => {}

  const wasRaw = process.stdin.isRaw
  process.stdin.setRawMode(true)
  process.stdin.resume()

  const onData = (data: Buffer): void => {
    const key = data.toString()

    if (key === "\t" && diffExpandEnabled && pendingDiffRunId) {
      const last = getLastDiff(pendingDiffRunId)
      if (last && last.diff.changed) {
        spinner.stop()
        console.log("")
        console.log(colors.muted(`    ┌── diff: ${last.path}`))
        const diffStr = formatDiffColored(last.diff)
        const diffLines = diffStr.split("\n").slice(0, 40)
        for (const line of diffLines) {
          console.log(colors.muted("    │ ") + line)
        }
        if (diffStr.split("\n").length > 40) {
          console.log(colors.muted(`    │ ... ${diffStr.split("\n").length - 40} more lines`))
        }
        console.log(colors.muted("    └──"))
        console.log("")
        spinner.start(colors.muted("thinking..."))
      }
      disableDiffExpand()
    }
  }

  process.stdin.on("data", onData)

  return () => {
    process.stdin.removeListener("data", onData)
    if (!wasRaw && process.stdin.isTTY) {
      try { process.stdin.setRawMode(false) } catch { /* ignore */ }
    }
  }
}

/** Used by render code that wants to emit the [Tab → diff] hint inline. */
export const DIFF_EXPAND_HINT = `${BOX.h} [Tab → diff]`
