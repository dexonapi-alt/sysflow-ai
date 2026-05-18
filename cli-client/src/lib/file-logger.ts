/**
 * File logger — cli-side mirror of `console.log` / `console.warn` /
 * `console.error` output to a daily-rotated file.
 *
 * NOTE: this taps `console.*` at the OS level, distinct from the
 * `events.ts` redirect (which routes console writes into the Ink
 * event bus for rendering inside `<AgentStream>`). The two layers
 * compose — the file logger captures whatever console calls happen
 * BEFORE the events.ts redirect wraps them, so it sees the original
 * call shape. If init order changes such that events.ts wraps first,
 * the file logger still works (it captures the wrapped call's
 * arguments). The redirect is order-independent.
 *
 * Resolution order for the log directory:
 *   1. `SYSFLOW_LOG_DIR` env var (explicit override — pointed at
 *      `<repo>/.sysflow-logs/` is the dev workflow).
 *   2. `~/.sysflow/logs/` — default, sits alongside the existing
 *      sysflow data dir (auth, model selection, etc.). Works
 *      regardless of which user-project dir the cli launched from.
 *
 * Toggle: disable with `SYSFLOW_FILE_LOG=0`.
 *
 * Best-effort: file-write failures never crash the cli.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

let writeStream: fs.WriteStream | null = null
let initialized = false

export function initFileLogger(): void {
  if (initialized) return
  initialized = true
  if (process.env.SYSFLOW_FILE_LOG === "0") return

  try {
    const logDir = resolveLogDir()
    fs.mkdirSync(logDir, { recursive: true })
    const date = new Date().toISOString().slice(0, 10)
    const logPath = path.join(logDir, `cli-${date}.log`)
    writeStream = fs.createWriteStream(logPath, { flags: "a" })

    const origLog = console.log
    const origWarn = console.warn
    const origError = console.error

    console.log = (...args: unknown[]): void => {
      writeFileLine("INFO", args)
      origLog(...args)
    }
    console.warn = (...args: unknown[]): void => {
      writeFileLine("WARN", args)
      origWarn(...args)
    }
    console.error = (...args: unknown[]): void => {
      writeFileLine("ERROR", args)
      origError(...args)
    }

    // Don't `console.log()` the announce — the cli's Ink mode redirects
    // console output into the bus, which won't be initialized yet at
    // this point. Write directly to stderr instead so the user sees it
    // before Ink mounts.
    process.stderr.write(`[file-logger] mirroring console → ${logPath}\n`)
  } catch (err) {
    process.stderr.write(`[file-logger] init failed (non-fatal): ${(err as Error).message}\n`)
  }
}

function resolveLogDir(): string {
  if (process.env.SYSFLOW_LOG_DIR) return process.env.SYSFLOW_LOG_DIR
  // The cli runs from arbitrary user-project dirs (e.g.
  // `C:/Users/<user>/Documents/test-3`), so resolving relative to cwd
  // would scatter logs across user projects. `~/.sysflow/logs/` mirrors
  // the existing `~/.sysflow/` data dir convention so the cli's logs
  // live in one stable place regardless of where it launched.
  return path.join(os.homedir(), ".sysflow", "logs")
}

function writeFileLine(level: string, args: unknown[]): void {
  if (!writeStream) return
  try {
    const ts = new Date().toISOString()
    const text = args
      .map((a) => {
        if (typeof a === "string") return a
        if (a instanceof Error) return `${a.name}: ${a.message}\n${a.stack ?? ""}`
        try { return JSON.stringify(a) } catch { return String(a) }
      })
      .join(" ")
    writeStream.write(`[${ts}] ${level} ${text}\n`)
  } catch {
    // best-effort
  }
}
