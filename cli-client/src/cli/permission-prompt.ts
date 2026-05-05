/**
 * Interactive permission prompt. Shown when checkPermissions returns 'ask'
 * and the run-scoped session cache has no prior answer for the same
 * (tool, pattern). Returns a PermissionDecision plus a flag describing
 * whether the user wants the answer to persist.
 */

import { colors, BOX } from "./render.js"
import { primaryPath, type PermissionDecision } from "../agent/permissions.js"

export interface PromptArgs {
  tool: string
  args: Record<string, unknown>
}

export interface PromptResult {
  decision: PermissionDecision
  /** When true, persist a rule to permissions.json. */
  persist: boolean
  /** Pattern to use when persisting; defaults to the primary path. */
  pattern?: string
}

export async function askPermission({ tool, args }: PromptArgs): Promise<PromptResult> {
  const target = primaryPath(tool, args) ?? "(no path)"

  console.log("")
  console.log("  " + colors.warning(BOX.tl + BOX.h.repeat(2)) + colors.warning(" PERMISSION ") + colors.warning(BOX.h.repeat(34) + BOX.tr))
  console.log("  " + colors.warning(BOX.v) + " " + colors.bright.bold(tool) + " " + colors.muted(target))
  console.log("  " + colors.warning(BOX.v))
  console.log("  " + colors.warning(BOX.v) + "  " + colors.success("[a]") + " allow once")
  console.log("  " + colors.warning(BOX.v) + "  " + colors.success("[A]") + " allow always for this " + colors.muted(`(${tool} on ${target})`))
  console.log("  " + colors.warning(BOX.v) + "  " + colors.error("[d]") + " deny once")
  console.log("  " + colors.warning(BOX.v) + "  " + colors.error("[D]") + " deny always")
  console.log("  " + colors.warning(BOX.bl + BOX.h.repeat(48) + BOX.br))
  process.stdout.write("  > ")

  const key = await readSingleKey()
  process.stdout.write(key + "\n")

  switch (key) {
    case "a":
      return { decision: "allow", persist: false }
    case "A":
      return { decision: "allow", persist: true, pattern: target }
    case "D":
      return { decision: "deny", persist: true, pattern: target }
    case "d":
    default:
      return { decision: "deny", persist: false }
  }
}

/**
 * Read one keystroke directly from raw stdin, bypassing readline. The chat
 * input loop owns a long-lived readline interface and calls `rl.pause()` to
 * mute it during agent runs, but pause() also pauses the underlying stdin —
 * so a fresh readline.question() here would never receive any input. Raw
 * mode + a one-shot data handler avoids that contention entirely.
 */
function readSingleKey(): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin
    const isTTY = stdin.isTTY
    const wasRaw = isTTY ? stdin.isRaw : false

    if (isTTY) stdin.setRawMode(true)
    stdin.resume()
    if (typeof (stdin as { setEncoding?: (e: string) => void }).setEncoding === "function") {
      stdin.setEncoding("utf8")
    }

    const onData = (chunk: string | Buffer): void => {
      const s = typeof chunk === "string" ? chunk : chunk.toString("utf8")
      // Ctrl-C: surface as deny + signal upstream so the run can be torn down.
      if (s === "") {
        cleanup()
        process.kill(process.pid, "SIGINT")
        resolve("d")
        return
      }
      // First printable character wins. Ignore stray escape sequences (arrows,
      // bracket-paste markers) that arrive as multi-byte chunks.
      const first = s.replace(/^\x1b\[[0-9;]*[~A-Za-z]/, "").charAt(0)
      if (!first) return
      cleanup()
      resolve(first)
    }

    function cleanup(): void {
      stdin.removeListener("data", onData)
      if (isTTY && !wasRaw) {
        try { stdin.setRawMode(false) } catch { /* ignore */ }
      }
    }

    stdin.on("data", onData)
  })
}
