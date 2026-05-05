/**
 * JobStatusBar — pinned bottom-row status line for background jobs.
 *
 * Renders via direct ANSI cursor positioning (no `ora` for this — `ora` owns
 * the cursor on the main row). Refreshes every 1 second while at least one
 * job is running. On completion, briefly shows ✓ for 3 seconds; on failure,
 * stays visible until explicitly stopped.
 *
 * Falls back to `console.log` when stdout isn't a TTY (CI, piped output).
 */

import { list as listJobs, type JobState } from "../agent/background-jobs.js"
import { colors, BOX } from "./render.js"

const REFRESH_MS = 1_000
const SUCCESS_LINGER_MS = 3_000

let timer: NodeJS.Timeout | null = null
let activeRunId: string | null = null
let paused = false
let lastRendered = ""
let recentlyCompleted = new Map<string, { state: JobState; clearAfterMs: number }>()
let sigintHandlerRegistered = false

function isTty(): boolean {
  return Boolean(process.stdout.isTTY)
}

function writeRaw(s: string): void {
  process.stdout.write(s)
}

function clearLine(): void {
  if (!isTty()) return
  // Save cursor, move to bottom, clear, restore.
  writeRaw("\x1B7\x1B[s")
  writeRaw("\x1B[" + (process.stdout.rows ?? 24) + ";1H")
  writeRaw("\x1B[2K")
  writeRaw("\x1B8\x1B[u")
}

function renderLine(text: string): void {
  if (!isTty()) {
    if (text !== lastRendered) {
      console.log(text)
      lastRendered = text
    }
    return
  }
  writeRaw("\x1B7\x1B[s")
  writeRaw("\x1B[" + (process.stdout.rows ?? 24) + ";1H")
  writeRaw("\x1B[2K")
  writeRaw(text)
  writeRaw("\x1B8\x1B[u")
  lastRendered = text
}

function describeJob(j: JobState): string {
  const seconds = Math.round(j.durationMs / 1000)
  const label = j.label.length > 30 ? j.label.slice(0, 28) + "…" : j.label
  if (j.status === "running") return colors.muted("⟳ ") + colors.accent(label) + colors.muted(` (${seconds}s)`)
  if (j.status === "done")    return colors.muted("✓ ") + colors.success(label) + colors.muted(` (${seconds}s)`)
  // failed
  return colors.muted("✖ ") + colors.error(label) + colors.muted(` (${seconds}s — exit ${j.exitCode ?? "?"})`)
}

function buildLine(jobs: JobState[]): string {
  const running = jobs.filter((j) => j.status === "running")
  const failed = jobs.filter((j) => j.status === "failed")
  // Show one primary + a count of others
  const primary = running[0] ?? failed[0]
  if (!primary) return ""
  const main = describeJob(primary)
  const others: string[] = []
  if (running.length > 1) others.push(`+${running.length - 1} more`)
  if (failed.length > 0 && primary.status !== "failed") others.push(`${failed.length} failed`)
  return others.length > 0 ? `${main}  ${colors.muted(others.join(" · "))}` : main
}

function tick(): void {
  if (paused || !activeRunId) return
  const now = Date.now()
  const live = listJobs(activeRunId)

  // Track newly-completed for the linger window.
  for (const j of live) {
    if (j.status !== "running") {
      if (!recentlyCompleted.has(j.id)) {
        recentlyCompleted.set(j.id, { state: j, clearAfterMs: now + SUCCESS_LINGER_MS })
      }
    } else {
      recentlyCompleted.delete(j.id)
    }
  }
  // Drop completed jobs whose linger window is up (and that succeeded).
  for (const [id, entry] of recentlyCompleted.entries()) {
    if (entry.state.status === "done" && entry.clearAfterMs < now) {
      recentlyCompleted.delete(id)
    }
  }

  const running = live.filter((j) => j.status === "running")
  const lingering: JobState[] = []
  for (const entry of recentlyCompleted.values()) {
    // Use the *current* state from listJobs if available so duration updates.
    const fresh = live.find((j) => j.id === entry.state.id) ?? entry.state
    lingering.push(fresh)
  }

  const display = buildLine([...running, ...lingering])
  if (display) {
    renderLine(display)
  } else {
    if (lastRendered) {
      clearLine()
      lastRendered = ""
    }
  }
}

function ensureSigintCleanup(): void {
  if (sigintHandlerRegistered) return
  sigintHandlerRegistered = true
  process.once("SIGINT", () => {
    clearLine()
    if (timer) clearInterval(timer)
    process.exit(130)
  })
}

export function startJobStatusBar(runId: string): void {
  if (timer) return  // already running
  activeRunId = runId
  paused = false
  lastRendered = ""
  recentlyCompleted = new Map()
  ensureSigintCleanup()
  // Don't render immediately — wait one tick so we don't flash on a no-op call.
  timer = setInterval(tick, REFRESH_MS)
}

export function stopJobStatusBar(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  clearLine()
  activeRunId = null
  paused = false
  lastRendered = ""
  recentlyCompleted = new Map()
}

/** Used by the main spinner when it needs to write to the bottom row. */
export function pauseJobStatusBar(): void {
  if (paused) return
  paused = true
  clearLine()
}

export function resumeJobStatusBar(): void {
  if (!paused) return
  paused = false
  // Force an immediate redraw on resume.
  tick()
}

/** Test-only: synchronous hook to render once. */
export function _tickForTests(): string {
  tick()
  return lastRendered
}
