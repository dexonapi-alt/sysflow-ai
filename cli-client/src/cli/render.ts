/**
 * Pure rendering primitives for the CLI agent UI.
 *
 * No state, no I/O beyond `console.log` / `process.stdout.write`. Anything that
 * holds keyboard listeners or run-scoped state lives in `diff-preview.ts` or the
 * controller (`agent.ts`).
 */

import chalk from "chalk"

export const colors = {
  accent: chalk.hex("#7C6FFF"),
  accentDim: chalk.hex("#5A50B8"),
  success: chalk.hex("#58D68D"),
  warning: chalk.hex("#F4D03F"),
  error: chalk.hex("#E74C3C"),
  info: chalk.hex("#5DADE2"),
  muted: chalk.hex("#7F8C8D"),
  bright: chalk.hex("#ECF0F1"),
  tool: chalk.hex("#48C9B0"),
  file: chalk.hex("#AEB6BF"),
  bar: chalk.hex("#34495E"),
}

export const BOX = {
  tl: "╭", tr: "╮", bl: "╰", br: "╯",
  h: "─", v: "│",
  lt: "├", rt: "┤",
  dot: "●", ring: "○", arrow: "▸", check: "✔", cross: "✖", dash: "─",
} as const

export function boxLine(width: number): string {
  return colors.bar(BOX.h.repeat(width))
}

export function boxTop(label: string, width = 40): string {
  const inner = ` ${label} `
  const pad = Math.max(0, width - inner.length - 2)
  return colors.bar(BOX.tl + BOX.h) + colors.accent.bold(inner) + colors.bar(BOX.h.repeat(pad) + BOX.tr)
}

export function boxMid(content: string, _width = 40): string {
  return colors.bar(BOX.v) + " " + content
}

export function boxBot(width = 40): string {
  return colors.bar(BOX.bl + BOX.h.repeat(width) + BOX.br)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function revealReasoning(text: string): Promise<void> {
  const maxLen = 280
  let display = text.trim()
  if (display.length > maxLen) {
    display = display.slice(0, maxLen).trimEnd() + "..."
  }

  const lines = display.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const line = `    ${colors.muted(BOX.v)} ${colors.muted(lines[i])}`
    console.log(line)
    if (lines.length > 1 && i < lines.length - 1) {
      await sleep(20)
    }
  }
  await sleep(60)
}

// ─── Tool label formatting ───

function extractPathFromArgs(args: Record<string, unknown>): string | null {
  for (const val of Object.values(args)) {
    if (typeof val === "string" && /^[\w./-]+\.\w+$/.test(val) && val.length < 200) {
      return val
    }
  }
  if (typeof args.args_json === "string") {
    try {
      const inner = JSON.parse(args.args_json)
      if (inner.path) return inner.path as string
    } catch { /* ignore */ }
  }
  return null
}

export function formatToolLabel(tool: string, args: Record<string, unknown>): string | null {
  if (!args) args = {}
  const filePath = (args.path as string)
    || (args.file_path as string)
    || (args.filePath as string)
    || extractPathFromArgs(args)
    || "(unknown)"

  switch (tool) {
    case "read_file":
      return colors.tool("read") + " " + colors.file(filePath)
    case "batch_read":
      return null
    case "write_file":
      return colors.tool("create") + " " + colors.file(filePath)
    case "edit_file":
      return colors.tool("edit") + " " + colors.file(filePath)
    case "create_directory":
      return colors.tool("mkdir") + " " + colors.file(filePath)
    case "move_file":
      return colors.tool("move") + " " + colors.file((args.from as string) || "?") + colors.muted(" → ") + colors.file((args.to as string) || "?")
    case "delete_file":
      return colors.tool("delete") + " " + colors.file(filePath)
    case "file_exists":
      return colors.tool("check") + " " + colors.file(filePath)
    case "search_code":
      return colors.tool("search") + " " + colors.bright(`"${args.pattern || ""}"`)
    case "search_files":
      return colors.tool("find") + " " + colors.bright(`"${args.query || args.glob || ""}"`)
    case "run_command":
      return colors.tool("run") + " " + colors.bright((args.command as string) || "(no command)")
    case "web_search":
      return colors.tool("search web") + " " + colors.bright(`"${args.query || ""}"`)
    case "batch_write": {
      const files = (args.files || []) as Array<{ path: string }>
      return colors.tool("batch write") + " " + colors.muted(`${files.length} files`)
    }
    default:
      // Stage 1 of plan 2026-05-16-server-hardening-and-error-source-distinction.md:
      // render explicitly-flagged invalid tools so the user sees the
      // failure mode clearly. Previously rendered as "unknown {}" which
      // looked like a real tool — masked the bug + made the DB-constraint
      // 500 traceback confusing.
      if (!tool || tool.length === 0) {
        return colors.tool("<invalid tool>") + " " + colors.muted(JSON.stringify(args))
      }
      return colors.tool(tool) + " " + colors.muted(JSON.stringify(args))
  }
}

export function isHiddenStep(tool: string): boolean {
  return tool === "list_directory"
}

// ─── Markdown → terminal renderer ───

export function renderMarkdown(text: string): string {
  let inCodeBlock = false
  const lines = text.split("\n")
  const result: string[] = []

  for (const raw of lines) {
    if (raw.trimStart().startsWith("```")) {
      inCodeBlock = !inCodeBlock
      continue
    }

    if (inCodeBlock) {
      result.push(colors.info(raw))
      continue
    }

    let line = raw

    if (/^#{1,3}\s/.test(line)) {
      result.push("")
      result.push(colors.accent.bold(line.replace(/^#{1,3}\s+/, "")))
      continue
    }

    if (line.trim() === "") {
      result.push("")
      continue
    }

    line = line.replace(/\*\*([^*]+)\*\*/g, (_m, b: string) => colors.bright.bold(b))
    line = line.replace(/`([^`]+)`/g, (_m, c: string) => colors.info(c))

    if (/^\s*[-*]\s/.test(line)) {
      line = line.replace(/^(\s*)([-*])\s/, `$1${colors.accent(BOX.arrow)} `)
      result.push(line)
      continue
    }

    if (/^\s*\d+\.\s/.test(line)) {
      line = line.replace(/^(\s*)(\d+\.)\s/, `$1${colors.accent("$2")} `)
      result.push(line)
      continue
    }

    result.push(line)
  }

  while (result.length > 0 && result[0] === "") result.shift()
  while (result.length > 0 && result[result.length - 1] === "") result.pop()

  return result.join("\n")
}

// ─── Pipeline / step rendering ───

export function stepIcon(status: string | undefined): string {
  if (status === "completed") return colors.success(BOX.check)
  if (status === "in_progress") return colors.accent(BOX.arrow)
  return colors.muted(BOX.ring)
}

export function stepLabel(label: string, status: string | undefined): string {
  if (status === "completed") return colors.success(label)
  if (status === "in_progress") return colors.accent.bold(label)
  return colors.muted(label)
}

export function renderPipelineBox(
  title: string,
  goal: string,
  steps: Array<{ id: string; label: string; status?: string }>,
  completedSet: Set<string>,
): void {
  const width = 46

  console.log("  " + colors.bar(BOX.tl + BOX.h) + colors.accent.bold(` ${title} `) + colors.bar(BOX.h.repeat(Math.max(0, width - title.length - 4)) + BOX.tr))
  console.log("  " + colors.bar(BOX.v) + " " + colors.muted(goal.length > width ? goal.slice(0, width - 3) + "..." : goal))
  console.log("  " + colors.bar(BOX.v))

  for (const s of steps) {
    const isDone = completedSet.has(s.id) || s.status === "completed"
    const isActive = s.status === "in_progress" && !isDone
    let icon: string
    let label: string
    if (isDone) {
      icon = colors.success(BOX.check)
      label = colors.success(s.label)
    } else if (isActive) {
      icon = colors.accent(BOX.arrow)
      label = colors.accent.bold(s.label)
    } else {
      icon = colors.muted(BOX.ring)
      label = colors.muted(s.label)
    }
    console.log("  " + colors.bar(BOX.v) + `  ${icon} ${label}`)
  }

  console.log("  " + colors.bar(BOX.bl + BOX.h.repeat(width) + BOX.br))
}

// ─── Phase 10: agent-progress renderer ───
//
// One-line natural-language summary of what the agent is about to do next
// and any issues from the previous step that need fixing. Deliberately
// avoids the implementation-detail "chunk N/M" terminology — the user
// shouldn't have to know the agent runs in a planner→execute→reflect loop.
// They just see "what is it about to do?" and (when it matters) "what
// went wrong with the last step?".
//
// Stays silent when the previous step landed clean — only the yellow ⚠ +
// issues list surface when the reflector flagged something.

interface ChunkPlanLike {
  nextAction?: string
  files?: string[]
  isFinalChunk?: boolean
}

interface ChunkReflectionLike {
  coherent?: boolean
  issues?: string[]
  shouldStop?: boolean
}

export function renderChunkProgress(args: {
  /** Unused in current rendering — kept for future telemetry hooks. */
  chunkIndex: number
  /** Just-resolved planner brief for the upcoming step. */
  plan?: ChunkPlanLike | null
  /** Reflector's verdict on the just-completed step. */
  reflection?: ChunkReflectionLike | null
  /** Phase 11 Stage 5: per-run awareness snapshot. When state ≠ on_track,
   *  the badge appears next to the upcoming step's label so the user always
   *  sees confidence drift before more work piles up. */
  awareness?: { state: AwarenessState; confidence: number; lastSignal?: string | null } | null
}): void {
  const { plan, reflection, awareness } = args
  if (!plan && !reflection) return

  // Surface reflector issues FIRST — these are the only attention-grabbing
  // things the user needs to see. Coherent-and-fine reflections stay silent.
  if (reflection?.coherent === false && reflection.issues && reflection.issues.length > 0) {
    const issueCount = reflection.issues.length
    console.log("  " + colors.warning(`⚠ ${issueCount} thing${issueCount === 1 ? "" : "s"} to fix from last step:`))
    for (const issue of reflection.issues.slice(0, 3)) {
      console.log("    " + colors.muted("• ") + colors.warning(issue))
    }
    if (issueCount > 3) {
      console.log("    " + colors.muted(`• …${issueCount - 3} more`))
    }
  }

  // Surface the upcoming step's intent in plain language, e.g. "▸ write models".
  if (plan?.nextAction) {
    const fileNote = Array.isArray(plan.files) && plan.files.length > 0
      ? colors.muted(` (${plan.files.length} file${plan.files.length === 1 ? "" : "s"})`)
      : ""
    // Render the badge inline only when not on_track — silent ✓ keeps the
    // happy path uncluttered. Blocked state already surfaces via the
    // off-course modal so the badge is just a redundant marker there.
    const badge = awareness && awareness.state !== "on_track"
      ? "  " + renderConfidenceBadge(awareness.state, awareness.confidence)
      : ""
    console.log("  " + colors.accent(BOX.arrow) + " " + colors.bright(plan.nextAction) + fileNote + badge)
    // When off_course, also surface the most recent divergence signal in a
    // single muted line so the user understands WHY the badge is yellow.
    if (awareness && awareness.state === "off_course" && awareness.lastSignal) {
      console.log("    " + colors.muted("• ") + colors.muted(awareness.lastSignal))
    }
  }
}

/**
 * Phase 11 Stage 5: confidence badge for the awareness loop.
 *
 * Pure: returns a styled string. Caller decides where to render it (status
 * line, chunk-progress box, off-course modal header). The state ↔ glyph map
 * is the single source of truth — confidence-tracker emits the state name
 * verbatim so this module stays the only place that knows the visual.
 *
 *   on_track  → green ✓     (≥ awareness.threshold_off_course, default 60)
 *   off_course → yellow ⚠   (in [threshold_blocked, threshold_off_course))
 *   blocked   → red ✖       (< awareness.threshold_blocked, default 30)
 */
export type AwarenessState = "on_track" | "off_course" | "blocked"

export function renderConfidenceBadge(state: AwarenessState, confidence?: number): string {
  const score = typeof confidence === "number" ? `${Math.round(confidence)}` : null
  switch (state) {
    case "on_track":
      return colors.success(BOX.check) + (score ? colors.muted(` ${score}`) : "")
    case "off_course":
      return colors.warning("⚠") + (score ? colors.warning(` ${score}`) : "")
    case "blocked":
      return colors.error(BOX.cross) + (score ? colors.error(` ${score}`) : "")
  }
}

export function printStepTransition(
  completedLabel: string | null | undefined,
  startedLabel: string | null | undefined,
): void {
  if (completedLabel && completedLabel !== "undefined") {
    console.log(`  ${colors.success(BOX.check)} ${colors.success(completedLabel)}`)
  }
  if (startedLabel && startedLabel !== "undefined") {
    console.log(`  ${colors.accent(BOX.arrow)} ${colors.accent.bold(startedLabel)}`)
  }
}
