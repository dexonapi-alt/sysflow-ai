/**
 * Interactive permission prompt. Shown when checkPermissions returns 'ask'
 * and the run-scoped session cache has no prior answer for the same
 * (tool, pattern). Returns a PermissionDecision plus a flag describing
 * whether the user wants the answer to persist.
 */

import readline from "node:readline"
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

  const answer = await ask("  > ")
  switch (answer) {
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

function ask(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close()
      resolve(answer.trim())
    })
  })
}
