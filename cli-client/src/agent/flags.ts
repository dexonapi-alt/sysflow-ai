/**
 * CLI-side feature flag registry. Mirror of server/src/services/flags.ts —
 * kept independent so the CLI doesn't drag a server import path in.
 *
 * Sources (precedence): SYSFLOW_FLAG_<NAME> env > <sysbasePath>/flags.json
 * > registered default. Memoised per-process; resetFlagCache() for tests.
 */

import fs from "node:fs"
import path from "node:path"

type Parser<T> = (raw: string) => T

interface RegisteredFlag<T> {
  name: string
  default: T
  parser: Parser<T>
}

const flags = new Map<string, RegisteredFlag<unknown>>()
let memo = new Map<string, unknown>()
let cachedFile: { path: string; mtime: number; data: Record<string, unknown> } | null = null

function envKey(name: string): string {
  return "SYSFLOW_FLAG_" + name.replace(/[.-]/g, "_").toUpperCase()
}

function defineFlag<T>(name: string, defaultValue: T, parser: Parser<T>): void {
  flags.set(name, { name, default: defaultValue, parser } as RegisteredFlag<unknown>)
}

const parseBool: Parser<boolean> = (raw) => raw === "1" || raw.toLowerCase() === "true" || raw.toLowerCase() === "yes"
const parseNumber: Parser<number> = (raw) => {
  const n = Number(raw)
  if (Number.isNaN(n)) throw new Error(`Invalid number: ${raw}`)
  return n
}

// ─── Initial CLI flag inventory ───
defineFlag("cli.tool_result_preview_enabled", true, parseBool)
defineFlag("cli.diff_preview_lines_max", 40, parseNumber)
defineFlag("cli.retry_max_default", 10, parseNumber)
defineFlag("cli.audit_retention_days", 14, parseNumber)

export function getFlag<T = unknown>(name: string, sysbasePath?: string | null): T {
  const memoKey = `${name}::${sysbasePath ?? ""}`
  if (memo.has(memoKey)) return memo.get(memoKey) as T

  const reg = flags.get(name)
  if (!reg) throw new Error(`Unknown flag: ${name}`)

  const envRaw = process.env[envKey(name)]
  if (envRaw != null) {
    try {
      const v = reg.parser(envRaw) as T
      memo.set(memoKey, v)
      return v
    } catch (err) {
      console.warn(`[flags] env override for ${name} unparseable (${(err as Error).message}) — falling through`)
    }
  }

  if (sysbasePath) {
    const fileVal = readFlagFile(sysbasePath)[name]
    if (fileVal !== undefined) {
      memo.set(memoKey, fileVal)
      return fileVal as T
    }
  }

  memo.set(memoKey, reg.default)
  return reg.default as T
}

function readFlagFile(sysbasePath: string): Record<string, unknown> {
  const filePath = path.join(sysbasePath, "flags.json")
  try {
    const stat = fs.statSync(filePath)
    if (cachedFile && cachedFile.path === filePath && cachedFile.mtime === stat.mtimeMs) {
      return cachedFile.data
    }
    const body = fs.readFileSync(filePath, "utf8")
    const parsed = JSON.parse(body)
    cachedFile = { path: filePath, mtime: stat.mtimeMs, data: parsed && typeof parsed === "object" ? parsed : {} }
    return cachedFile.data
  } catch {
    return {}
  }
}

export function resetFlagCache(): void {
  memo = new Map()
  cachedFile = null
}

export function listFlags(): Array<{ name: string; default: unknown }> {
  return Array.from(flags.values()).map((f) => ({ name: f.name, default: f.default }))
}
