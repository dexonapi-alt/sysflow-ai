/**
 * Off-course modal — Phase 11 Stage 4.
 *
 * Mirrors `permission-prompt.ts`'s structure: a raw-TTY single-keystroke
 * modal that reads stdin without involving the agent's chat input loop.
 *
 * Shown when the server signals `awarenessChoice: true` on a
 * `waiting_for_user` response — i.e. the per-run confidence tracker
 * crossed the `blocked` threshold and the agent should hand the wheel
 * back before piling more wrong work on top.
 *
 * Three keys:
 *   c → continue: agent proceeds (signals are cleared + a 2-chunk
 *                 cooldown prevents an immediate re-fire).
 *   b → backtrack: cli rolls back to the snapshot taken at the start of
 *                  the chunk that triggered the block, then resumes.
 *   r → redirect: prompts for free-text correction; the next planner
 *                 call sees it as injected context.
 *
 * Returns the user's choice; the caller (agent.ts) is responsible for
 * doing the rollback (Phase 11 Stage 2's `rollbackToChunk`) before
 * round-tripping the action back to the server.
 */

import readline from "node:readline"
import { colors, BOX } from "./render.js"
import { pauseSpinner, resumeSpinner } from "./spinner-control.js"

export interface OffCourseEvidence {
  /** Top divergence signals to surface inline. Empty array is allowed but unusual. */
  signals: Array<{ category: string; detail: string; severity?: string }>
  /** Optional last LLM verdict — when set, render its mismatches and suggestion. */
  lastLlmVerdict?: { mismatches: string[]; suggestion: "continue" | "pause" | "backtrack"; score: number } | null
  /** Confidence at the moment of pause (0-100). */
  confidence: number
  /** Chunk index the cli should roll back to on `backtrack`. */
  lastGoodChunkIndex: number
}

export type OffCourseAction = "continue" | "backtrack" | "redirect"

export interface OffCourseResult {
  action: OffCourseAction
  /** Free-text correction the user typed, only set when action === "redirect". */
  text?: string
}

const BOX_WIDTH = 64
const MAX_SIGNAL_LINES = 5

export async function askOffCourse(evidence: OffCourseEvidence): Promise<OffCourseResult> {
  pauseSpinner()

  console.log("")
  drawHeader(" OFF COURSE ", BOX_WIDTH)
  console.log("  " + colors.warning(BOX.v) + " " + colors.bright.bold(`Confidence dropped to ${Math.round(evidence.confidence)}/100`))
  console.log("  " + colors.warning(BOX.v) + " " + colors.muted("I think the run drifted from your ask. What should I do?"))

  if (evidence.signals.length > 0) {
    console.log("  " + colors.warning(BOX.v))
    console.log("  " + colors.warning(BOX.v) + " " + colors.muted("Evidence:"))
    for (const sig of evidence.signals.slice(0, MAX_SIGNAL_LINES)) {
      const sevTag = sig.severity ? colors.muted(`[${sig.severity}] `) : ""
      console.log("  " + colors.warning(BOX.v) + "   " + sevTag + truncate(sig.detail, BOX_WIDTH - 8))
    }
    const hidden = Math.max(0, evidence.signals.length - MAX_SIGNAL_LINES)
    if (hidden > 0) {
      console.log("  " + colors.warning(BOX.v) + "   " + colors.muted(`… ${hidden} more signal(s) hidden`))
    }
  }

  if (evidence.lastLlmVerdict && evidence.lastLlmVerdict.mismatches.length > 0) {
    console.log("  " + colors.warning(BOX.v))
    console.log("  " + colors.warning(BOX.v) + " " + colors.muted(`LLM second-opinion (score ${evidence.lastLlmVerdict.score}, suggests ${evidence.lastLlmVerdict.suggestion}):`))
    for (const m of evidence.lastLlmVerdict.mismatches.slice(0, 3)) {
      console.log("  " + colors.warning(BOX.v) + "   " + truncate(m, BOX_WIDTH - 6))
    }
  }

  console.log("  " + colors.warning(BOX.v))
  console.log("  " + colors.warning(BOX.v) + "  " + colors.success("[c]") + " continue (override — keep going)")
  console.log("  " + colors.warning(BOX.v) + "  " + colors.warning("[b]") + " backtrack (rollback to chunk " + evidence.lastGoodChunkIndex + ")")
  console.log("  " + colors.warning(BOX.v) + "  " + colors.accent("[r]") + " redirect (give a corrected direction)")
  console.log("  " + colors.warning(BOX.bl + BOX.h.repeat(BOX_WIDTH) + BOX.br))
  process.stdout.write("  > ")

  const key = await readSingleKey()
  process.stdout.write(key + "\n")

  if (key === "c" || key === "C") {
    resumeSpinner()
    return { action: "continue" }
  }
  if (key === "b" || key === "B") {
    console.log(colors.warning(`  ↩ rolling back to chunk ${evidence.lastGoodChunkIndex}…`))
    resumeSpinner()
    return { action: "backtrack" }
  }
  // Default to redirect — covers `r` and any other key (mistype = chance to re-direct
  // is safer than mistype = silent continue).
  console.log("")
  const text = await askForText("  Tell me what to fix: ")
  resumeSpinner()
  if (!text) return { action: "continue" } // empty redirect collapses to continue
  return { action: "redirect", text }
}

function drawHeader(label: string, width: number): void {
  const labelWidth = label.length
  const left = 2
  const right = Math.max(0, width - left - labelWidth)
  console.log(
    "  " +
    colors.warning(BOX.tl + BOX.h.repeat(left)) +
    colors.warning(label) +
    colors.warning(BOX.h.repeat(right) + BOX.tr),
  )
}

function truncate(s: string, width: number): string {
  if (s.length <= width) return s
  return s.slice(0, Math.max(0, width - 1)) + "…"
}

/**
 * Same raw-TTY single-key reader as `permission-prompt.ts`. We keep our
 * own copy to avoid coupling the two modals and so the off-course flow
 * doesn't import permission internals.
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
      if (s === "") {
        cleanup()
        process.kill(process.pid, "SIGINT")
        resolve("c")
        return
      }
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

function askForText(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.question(colors.accent(prompt), (answer) => {
      rl.close()
      resolve((answer ?? "").trim())
    })
  })
}
