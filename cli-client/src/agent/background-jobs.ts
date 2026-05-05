/**
 * Background-job registry. Spawns child processes for install-class commands
 * that should run while the agent continues working.
 *
 * Per-run limits:
 *   - MAX_CONCURRENT_PER_RUN = 3 (start() throws when exceeded)
 *   - MAX_JOB_DURATION_MS    = 5 * 60_000 (per-job watchdog SIGTERMs)
 *   - WAIT_TIMEOUT_MS        = 30_000 (cleanupRun gives outstanding jobs
 *                                       this long before SIGTERM)
 *
 * State is in-memory only. Jobs die with the CLI process — cross-run
 * persistence is explicitly out of scope for Phase 7.
 */

import { spawn, type ChildProcess } from "node:child_process"
import crypto from "node:crypto"

export type JobStatus = "running" | "done" | "failed"

export interface JobState {
  id: string
  runId: string
  command: string
  cwd: string
  label: string
  status: JobStatus
  startedAt: number
  endedAt?: number
  exitCode?: number | null
  stdoutTail: string
  stderrTail: string
  durationMs: number
  /** Set when the watchdog or cleanupRun killed the process. */
  abortReason?: "watchdog_timeout" | "run_exit"
}

export interface StartArgs {
  command: string
  cwd: string
  runId: string
  label?: string
}

const MAX_CONCURRENT_PER_RUN = 3
const MAX_JOB_DURATION_MS = 5 * 60_000
const WAIT_TIMEOUT_MS = 30_000
const TAIL_BYTES = 4 * 1024  // 4 KiB of stdout/stderr kept per job

interface InternalJob extends JobState {
  child: ChildProcess
  watchdog: NodeJS.Timeout
  exitWaiters: Array<(state: JobState) => void>
}

const jobs = new Map<string, InternalJob>()

function nowMs(): number {
  return Date.now()
}

function newJobId(): string {
  return "job_" + crypto.randomBytes(6).toString("hex")
}

function appendTail(existing: string, chunk: Buffer): string {
  const next = existing + chunk.toString("utf8")
  if (next.length <= TAIL_BYTES) return next
  return next.slice(next.length - TAIL_BYTES)
}

function snapshot(job: InternalJob): JobState {
  // Strip child + watchdog + waiters before exposing.
  const { child: _c, watchdog: _w, exitWaiters: _e, ...rest } = job
  void _c; void _w; void _e
  return { ...rest, durationMs: (job.endedAt ?? nowMs()) - job.startedAt }
}

function listForRun(runId: string): InternalJob[] {
  return [...jobs.values()].filter((j) => j.runId === runId)
}

export function start(args: StartArgs): JobState {
  const running = listForRun(args.runId).filter((j) => j.status === "running")
  if (running.length >= MAX_CONCURRENT_PER_RUN) {
    throw new Error(`Too many concurrent background jobs for this run (${running.length}/${MAX_CONCURRENT_PER_RUN}). Wait for one to finish or call check_jobs to see them.`)
  }

  const isWindows = process.platform === "win32"
  const shell = isWindows ? "cmd.exe" : "/bin/sh"
  const shellArgs = isWindows ? ["/c", args.command] : ["-c", args.command]

  const child = spawn(shell, shellArgs, {
    cwd: args.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, FORCE_COLOR: "0" },
  })

  const id = newJobId()
  const watchdog = setTimeout(() => {
    const job = jobs.get(id)
    if (!job || job.status !== "running") return
    job.abortReason = "watchdog_timeout"
    try { job.child.kill("SIGTERM") } catch { /* already dead */ }
  }, MAX_JOB_DURATION_MS)

  const job: InternalJob = {
    id,
    runId: args.runId,
    command: args.command,
    cwd: args.cwd,
    label: args.label || args.command.slice(0, 60),
    status: "running",
    startedAt: nowMs(),
    stdoutTail: "",
    stderrTail: "",
    durationMs: 0,
    child,
    watchdog,
    exitWaiters: [],
  }
  jobs.set(id, job)

  child.stdout?.on("data", (chunk: Buffer) => {
    job.stdoutTail = appendTail(job.stdoutTail, chunk)
  })
  child.stderr?.on("data", (chunk: Buffer) => {
    job.stderrTail = appendTail(job.stderrTail, chunk)
  })

  child.on("exit", (code, signal) => {
    clearTimeout(job.watchdog)
    job.endedAt = nowMs()
    job.exitCode = code ?? null
    if (job.abortReason) {
      job.status = "failed"
    } else if (signal) {
      job.status = "failed"
      if (!job.abortReason) job.abortReason = "run_exit"
    } else {
      job.status = code === 0 ? "done" : "failed"
    }
    job.durationMs = job.endedAt - job.startedAt
    const finalState = snapshot(job)
    for (const w of job.exitWaiters.splice(0)) {
      try { w(finalState) } catch { /* noop */ }
    }
  })

  child.on("error", (err) => {
    clearTimeout(job.watchdog)
    job.endedAt = nowMs()
    job.status = "failed"
    job.exitCode = null
    job.stderrTail = appendTail(job.stderrTail, Buffer.from((err as Error).message))
    job.durationMs = job.endedAt - job.startedAt
    const finalState = snapshot(job)
    for (const w of job.exitWaiters.splice(0)) {
      try { w(finalState) } catch { /* noop */ }
    }
  })

  return snapshot(job)
}

export function poll(jobId: string): JobState | null {
  const job = jobs.get(jobId)
  if (!job) return null
  return snapshot(job)
}

export function list(runId: string): JobState[] {
  const all = listForRun(runId).map(snapshot)
  // Running first, then by startedAt descending.
  return all.sort((a, b) => {
    if (a.status === "running" && b.status !== "running") return -1
    if (b.status === "running" && a.status !== "running") return 1
    return b.startedAt - a.startedAt
  })
}

export function wait(jobId: string, timeoutMs: number): Promise<JobState> {
  const job = jobs.get(jobId)
  if (!job) return Promise.resolve({
    id: jobId,
    runId: "",
    command: "",
    cwd: "",
    label: "",
    status: "failed",
    startedAt: 0,
    endedAt: 0,
    exitCode: null,
    stdoutTail: "",
    stderrTail: "(unknown jobId)",
    durationMs: 0,
  })
  if (job.status !== "running") return Promise.resolve(snapshot(job))

  return new Promise<JobState>((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve(snapshot(job))  // still running; caller decides what to do
    }, timeoutMs)
    job.exitWaiters.push((state) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(state)
    })
  })
}

export async function cleanupRun(runId: string, waitMs: number = WAIT_TIMEOUT_MS): Promise<{ awaited: number; aborted: number }> {
  const running = listForRun(runId).filter((j) => j.status === "running")
  if (running.length === 0) return { awaited: 0, aborted: 0 }

  const results = await Promise.all(
    running.map((j) => wait(j.id, waitMs)),
  )

  let awaited = 0
  let aborted = 0
  for (const state of results) {
    if (state.status === "running") {
      // Still alive after the wait — kill it.
      const job = jobs.get(state.id)
      if (job) {
        job.abortReason = "run_exit"
        try { job.child.kill("SIGTERM") } catch { /* */ }
      }
      aborted += 1
    } else {
      awaited += 1
    }
  }
  return { awaited, aborted }
}

/** Drop a single job from memory (used after the agent's tool_result is consumed). */
export function forget(jobId: string): void {
  const job = jobs.get(jobId)
  if (!job) return
  if (job.status === "running") {
    try { job.child.kill("SIGTERM") } catch { /* */ }
    clearTimeout(job.watchdog)
  }
  jobs.delete(jobId)
}

/** Test-only: clear every job. */
export function _resetForTests(): void {
  for (const job of jobs.values()) {
    try { job.child.kill("SIGTERM") } catch { /* */ }
    clearTimeout(job.watchdog)
  }
  jobs.clear()
}

export const _CONFIG = {
  MAX_CONCURRENT_PER_RUN,
  MAX_JOB_DURATION_MS,
  WAIT_TIMEOUT_MS,
  TAIL_BYTES,
}
