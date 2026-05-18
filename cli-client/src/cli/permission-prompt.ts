/**
 * Interactive permission prompt. Shown when checkPermissions returns 'ask'
 * and the run-scoped session cache has no prior answer for the same
 * (tool, pattern). Returns a PermissionDecision plus a flag describing
 * whether the user wants the answer to persist.
 */

import fs from "node:fs/promises"
import path from "node:path"
import { colors, BOX } from "./render.js"
import { primaryPath, type PermissionDecision } from "../agent/permissions.js"
import { computeDiff } from "../agent/diff.js"
import { pauseSpinner, resumeSpinner } from "./spinner-control.js"
import { emitAgent } from "../agent/events.js"

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

const DEFAULT_BOX_WIDTH = 64
const MIN_BOX_WIDTH = 32
const MAX_BOX_WIDTH = 80
const DIFF_PREVIEW_LINES = 12

/**
 * Stage 5 of plan 2026-05-18-ui-ux-polish-and-action-aware-spinner.md
 * (audit issue #6): pure helper that picks the permission-modal box
 * width based on the available terminal columns. Pre-Stage-5 the box
 * was hardcoded to 64 cols, which:
 *   - wrapped on narrow terminals (60-col iTerm2 split panes)
 *   - under-used wide terminals (120-col single panes truncated diff
 *     lines that were perfectly readable)
 *
 * Width policy:
 *   - clamp to [MIN_BOX_WIDTH .. MAX_BOX_WIDTH]
 *   - leave 4 cols of terminal headroom (2-col left indent + 2-col
 *     right safety margin)
 *   - fall back to DEFAULT_BOX_WIDTH when columns is 0 / undefined
 *     (non-TTY or stub)
 *
 * Exported for direct tests.
 */
export function pickPermissionBoxWidth(columns: number | undefined): number {
  if (typeof columns !== "number" || !Number.isFinite(columns) || columns <= 0) {
    return DEFAULT_BOX_WIDTH
  }
  const target = columns - 4
  if (target < MIN_BOX_WIDTH) return MIN_BOX_WIDTH
  if (target > MAX_BOX_WIDTH) return MAX_BOX_WIDTH
  return target
}

export async function askPermission({ tool, args }: PromptArgs): Promise<PromptResult> {
  // Stop the agent's spinner so the modal paints on a clean line and isn't
  // overdrawn by the next dot animation tick.
  pauseSpinner()
  // Stage 5 of plan 2026-05-18-ui-ux-polish-and-action-aware-spinner.md
  // (audit issue #5): announce modal control so InteractiveHints switches
  // its bottom-row keybindings to the permission-modal set.
  emitAgent({ type: "modal_active", modal: "permission" })

  const target = primaryPath(tool, args) ?? "(no path)"
  // Stage 5 of plan 2026-05-18-ui-ux-polish-and-action-aware-spinner.md
  // (audit issue #6): read the terminal width once on modal entry and
  // size the box to match. The box reads at-modal-mount, so a resize
  // mid-modal won't re-flow — acceptable for a short-lived prompt.
  const boxWidth = pickPermissionBoxWidth(process.stdout.columns)

  console.log("")
  drawHeader(" PERMISSION ", boxWidth)
  console.log("  " + colors.warning(BOX.v) + " " + colors.bright.bold(tool) + " " + colors.muted(target))

  // Inline diff preview for write_file / edit_file. Lets the user see the
  // exact +/- lines before granting permission instead of clicking
  // [Tab → diff] AFTER the fact.
  if (tool === "write_file" || tool === "edit_file") {
    const preview = await renderDiffInline(args, boxWidth)
    if (preview.length > 0) {
      console.log("  " + colors.warning(BOX.v))
      for (const line of preview) console.log(line)
    }
  }

  console.log("  " + colors.warning(BOX.v))
  console.log("  " + colors.warning(BOX.v) + "  " + colors.success("[a]") + " allow once")
  console.log("  " + colors.warning(BOX.v) + "  " + colors.success("[A]") + " allow always for this " + colors.muted(`(${tool} on ${target})`))
  console.log("  " + colors.warning(BOX.v) + "  " + colors.error("[d]") + " deny once")
  console.log("  " + colors.warning(BOX.v) + "  " + colors.error("[D]") + " deny always")
  console.log("  " + colors.warning(BOX.bl + BOX.h.repeat(boxWidth) + BOX.br))
  process.stdout.write("  > ")

  const key = await readSingleKey()
  // Echo the chosen key + visual gap before the agent stream resumes.
  process.stdout.write(key + "\n\n")

  let result: PromptResult
  switch (key) {
    case "a":
      result = { decision: "allow", persist: false }
      break
    case "A":
      result = { decision: "allow", persist: true, pattern: target }
      break
    case "D":
      result = { decision: "deny", persist: true, pattern: target }
      break
    case "d":
    default:
      result = { decision: "deny", persist: false }
      break
  }

  // Stage 5 of plan 2026-05-18-ui-ux-polish-and-action-aware-spinner.md:
  // release modal control so InteractiveHints reverts to the working /
  // idle hint set.
  emitAgent({ type: "modal_dismissed" })
  resumeSpinner()
  return result
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

/**
 * Build a few lines of `+ added / - removed` preview for a write/edit. Returns
 * an array of pre-formatted lines (already prefixed with the box `│ `). Empty
 * array means "no diff to show" (e.g., couldn't read source, or no change).
 *
 * Stage 5 of plan 2026-05-18-ui-ux-polish-and-action-aware-spinner.md
 * (audit issue #6): takes the modal's resolved box width so diff lines
 * truncate to the same right edge as the rest of the modal.
 */
async function renderDiffInline(args: Record<string, unknown>, boxWidth: number): Promise<string[]> {
  const filePath = args.path as string | undefined
  if (!filePath) return []

  const newContent = await resolveNewContent(args)
  if (newContent == null) return []

  let oldContent: string | null = null
  try {
    const abs = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath)
    oldContent = await fs.readFile(abs, "utf8")
  } catch {
    oldContent = null  // brand-new file
  }

  const diff = computeDiff(oldContent, newContent, 1)
  if (!diff.changed) return []

  const lines: string[] = []
  const verticalBar = "  " + colors.warning(BOX.v) + " "
  const summary = formatSummary(diff.added, diff.removed)
  lines.push(verticalBar + colors.muted(`diff: ${filePath}`) + "  " + summary)

  let printed = 0
  let truncated = 0
  for (const hunk of diff.hunks) {
    if (printed >= DIFF_PREVIEW_LINES) {
      truncated += hunk.lines.filter((l) => l.type !== "context").length
      continue
    }
    for (const line of hunk.lines) {
      if (printed >= DIFF_PREVIEW_LINES) {
        if (line.type !== "context") truncated += 1
        continue
      }
      if (line.type === "add") {
        lines.push(verticalBar + colors.success("+ ") + colors.success(truncate(line.content, boxWidth - 4)))
        printed += 1
      } else if (line.type === "remove") {
        lines.push(verticalBar + colors.error("- ") + colors.error(truncate(line.content, boxWidth - 4)))
        printed += 1
      }
      // skip context lines in the inline preview to keep it tight
    }
  }
  if (truncated > 0) {
    lines.push(verticalBar + colors.muted(`… ${truncated} more change line(s) hidden`))
  }
  return lines
}

/**
 * Pull the would-be new file content out of the tool args. The shape varies:
 *   - write_file: { path, content }
 *   - edit_file (search/replace): { path, search, replace }
 *   - edit_file (line-range): { path, line_start, line_end, content }
 *   - edit_file (insert_at): { path, insert_at, content }
 *
 * For write_file we have full content. For edit_file variants we synthesise
 * the post-edit content from the on-disk file + the patch so the diff is
 * accurate. Returns null when we can't reconstruct (caller skips the preview).
 */
async function resolveNewContent(args: Record<string, unknown>): Promise<string | null> {
  if (typeof args.content === "string" && args.search === undefined && args.line_start === undefined && args.insert_at === undefined) {
    return args.content as string
  }
  const filePath = args.path as string
  let current = ""
  try {
    const abs = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath)
    current = await fs.readFile(abs, "utf8")
  } catch {
    return null
  }

  if (typeof args.search === "string" && typeof args.replace === "string") {
    return current.split(args.search).join(args.replace)
  }

  const lines = current.split("\n")
  if (typeof args.line_start === "number") {
    const start = (args.line_start as number) - 1
    const end = ((args.line_end as number) || (args.line_start as number)) - 1
    const replacement = (args.content as string || "").split("\n")
    return [...lines.slice(0, start), ...replacement, ...lines.slice(end + 1)].join("\n")
  }
  if (typeof args.insert_at === "number") {
    const at = (args.insert_at as number) - 1
    const insert = (args.content as string || "").split("\n")
    return [...lines.slice(0, at), ...insert, ...lines.slice(at)].join("\n")
  }
  return null
}

function formatSummary(added: number, removed: number): string {
  const parts: string[] = []
  if (added > 0) parts.push(colors.success(`+${added}`))
  if (removed > 0) parts.push(colors.error(`-${removed}`))
  return parts.join(" ")
}

function truncate(s: string, width: number): string {
  if (s.length <= width) return s
  return s.slice(0, Math.max(0, width - 1)) + "…"
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
      if (s === "") {
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
