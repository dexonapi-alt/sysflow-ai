/**
 * File logger — mirrors `console.log` / `console.warn` / `console.error`
 * output to a daily-rotated file under the project's log directory.
 *
 * Resolution order for the log directory:
 *   1. `SYSFLOW_LOG_DIR` env var (explicit override)
 *   2. `<server-cwd>/../.sysflow-logs/` — the repo-root logs folder
 *      (default in dev: server runs from `server/` workspace dir, so
 *      `../` is the monorepo root). Created on first init.
 *
 * Toggle: disable with `SYSFLOW_FILE_LOG=0`. Default ON in dev so the
 * user can `tail -f .sysflow-logs/server-<date>.log` while the agent
 * works end-to-end.
 *
 * Best-effort: file-write failures never crash the server. The console
 * output continues regardless.
 *
 * Format: `[<ISO-timestamp>] <LEVEL> <message>` — plain text, one line
 * per console call, args joined with spaces. Objects are JSON-encoded.
 */

import fs from "node:fs"
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
    const logPath = path.join(logDir, `server-${date}.log`)
    writeStream = fs.createWriteStream(logPath, { flags: "a" })

    // Tap console output. Chain on top of any existing patch (e.g. test
    // harness overrides) so we don't clobber other consumers.
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

    // Announce on stdout so the user sees where logs are landing.
    origLog(`[file-logger] mirroring console → ${logPath}`)
  } catch (err) {
    process.stderr.write(`[file-logger] init failed (non-fatal): ${(err as Error).message}\n`)
  }
}

function resolveLogDir(): string {
  if (process.env.SYSFLOW_LOG_DIR) return process.env.SYSFLOW_LOG_DIR
  // `server/` is the cwd in dev (`npm run dev -w server`). One level up
  // is the monorepo root where the `.sysflow-logs/` directory lives.
  return path.resolve(process.cwd(), "..", ".sysflow-logs")
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
    // best-effort; do NOT throw from the console.log path
  }
}
