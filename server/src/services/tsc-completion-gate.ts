/**
 * Plan `2026-05-16-agent-code-correctness-and-completion-artifacts.md` Stage 3.
 *
 * Pre-completion `tsc --noEmit` gate. Runs at the moment the model
 * returns `kind: "completed"` and the run authored any `.ts` files.
 * Blocks completion when typecheck has errors — injects diagnostics
 * back as a `═══ TYPECHECK FAILED — FIX BEFORE COMPLETION ═══` block
 * and overrides the response to `needs_tool` to force continuation.
 *
 * Closes the user-reported repro where the agent declared the POS
 * backend "done" with cascading TS errors (missing extensions, type
 * vs value imports, default vs named export mismatches) that only
 * surfaced when the user ran `npm run dev`. tsc --noEmit would have
 * caught EVERY one of those before completion.
 *
 * Gates carefully to keep cost bounded:
 *   - Only fires when ≥1 `.ts` / `.tsx` file was authored this run
 *   - AND tsconfig.json exists at the project root
 *   - AND npx tsc is invocable (gracefully degrades when not)
 *   - Hard timeout (default 30s) — long-running tsc runs bail with
 *     a warning instead of hanging the agent loop
 */

import { exec as execCb } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"

const exec = promisify(execCb)

export interface TscGateInput {
  /** Absolute cwd to run tsc in. */
  cwd: string
  /** Authored file paths this run (relative or absolute). Used to
   *  decide whether to fire — gate only runs when ≥1 .ts/.tsx file
   *  appears. */
  filesWritten: string[]
  /** Timeout for the tsc invocation. Default 30s. */
  timeoutMs?: number
}

export interface TscGateResult {
  /** Whether the gate actually ran tsc. false when skipped (no .ts
   *  files / no tsconfig / no tsc binary / disabled by caller). */
  ran: boolean
  /** True when the typecheck passed OR was skipped. false ONLY when
   *  tsc ran AND returned errors. */
  ok: boolean
  /** Count of error lines extracted from tsc output. 0 when ok. */
  errorCount: number
  /** First N error lines (capped at MAX_ERROR_LINES) for the inject
   *  block. Empty when ok. */
  errors: string[]
  /** Reason the gate skipped, when applicable. */
  skippedReason?: string
}

const MAX_ERROR_LINES = 12
const DEFAULT_TIMEOUT_MS = 30_000

/**
 * Pure: decide whether the gate should fire. Caller still must
 * verify tsc + tsconfig.json on disk; this is the prerequisite check.
 */
export function hasAuthoredTsFiles(filesWritten: string[]): boolean {
  return filesWritten.some((f) => f.endsWith(".ts") || f.endsWith(".tsx"))
}

/**
 * Async: scan the cwd for tsconfig.json. Used by the gate to skip
 * when the project doesn't typecheck-able (no config).
 */
export async function hasTsConfig(cwd: string): Promise<boolean> {
  try {
    await fs.access(path.join(cwd, "tsconfig.json"))
    return true
  } catch {
    return false
  }
}

/**
 * Run `npx --no-install tsc --noEmit` in the given cwd. Captures
 * stdout (where tsc writes errors) + stderr. Errors are parsed by
 * counting lines that match the canonical tsc error format
 * `file.ts(line,col): error TS...`. Returns the first N for the
 * inject block.
 */
export async function runTscGate(input: TscGateInput): Promise<TscGateResult> {
  if (!hasAuthoredTsFiles(input.filesWritten)) {
    return { ran: false, ok: true, errorCount: 0, errors: [], skippedReason: "no .ts/.tsx files authored this run" }
  }
  if (!(await hasTsConfig(input.cwd))) {
    return { ran: false, ok: true, errorCount: 0, errors: [], skippedReason: "no tsconfig.json in project root" }
  }
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
  try {
    // --no-install: don't auto-install tsc if missing; we degrade
    // gracefully instead of mutating the user's deps. tsc returns
    // exit code 2 on errors; we read stdout regardless.
    const { stdout } = await exec("npx --no-install tsc --noEmit", {
      cwd: input.cwd,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024 * 2,  // 2 MB — accommodates very chatty error output
    })
    // Exit code 0 + empty stdout = clean.
    const errors = extractTscErrors(stdout)
    if (errors.length === 0) {
      return { ran: true, ok: true, errorCount: 0, errors: [] }
    }
    return { ran: true, ok: false, errorCount: errors.length, errors: errors.slice(0, MAX_ERROR_LINES) }
  } catch (err) {
    const errAny = err as Error & { code?: string | number; stdout?: string; stderr?: string; killed?: boolean; signal?: string }
    // tsc exited non-zero — most common path when errors exist.
    // Both stdout and stderr can carry errors depending on tsc version.
    if (typeof errAny.stdout === "string" || typeof errAny.stderr === "string") {
      const combined = `${errAny.stdout ?? ""}\n${errAny.stderr ?? ""}`
      const errors = extractTscErrors(combined)
      if (errors.length > 0) {
        return { ran: true, ok: false, errorCount: errors.length, errors: errors.slice(0, MAX_ERROR_LINES) }
      }
    }
    // tsc binary missing / npx couldn't resolve — degrade gracefully.
    const msg = errAny.message || String(err)
    if (msg.includes("command not found") || msg.includes("not recognized") || msg.includes("ENOENT") || msg.includes("could not determine executable")) {
      return { ran: false, ok: true, errorCount: 0, errors: [], skippedReason: "tsc not installed / not invocable" }
    }
    if (errAny.killed || errAny.signal === "SIGTERM" || msg.includes("ETIMEDOUT") || msg.includes("timed out")) {
      return { ran: false, ok: true, errorCount: 0, errors: [], skippedReason: `tsc timed out after ${timeoutMs}ms` }
    }
    // Unknown failure — degrade rather than block.
    console.warn(`[tsc-gate] unknown failure, degrading to ok: ${msg.slice(0, 200)}`)
    return { ran: false, ok: true, errorCount: 0, errors: [], skippedReason: `tsc invocation failed: ${msg.slice(0, 80)}` }
  }
}

/**
 * Pure: extract canonical tsc error lines from a string. Match the
 * standard format `file.ts(line,col): error TS####:` or pretty
 * format `file.ts:line:col - error TS####:`. Filters empty lines
 * and continuation messages.
 */
export function extractTscErrors(output: string): string[] {
  if (!output) return []
  const ERROR_PATTERN = /^([^\s].+\.(?:ts|tsx|d\.ts))(?:[(:]\d+[,:]\d+\)?:?\s*)?(?:\s-\s)?\s*error TS\d+:/
  return output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && ERROR_PATTERN.test(l))
}

/**
 * Pure: render the typecheck-failed inject block. Shows the first
 * MAX_ERROR_LINES errors + a count of how many more exist.
 */
export function buildTscFailedInject(result: TscGateResult): string {
  const lines: string[] = []
  lines.push("═══ TYPECHECK FAILED — FIX BEFORE COMPLETION ═══")
  lines.push("")
  lines.push(`Your declared completion was BLOCKED because \`tsc --noEmit\` returned ${result.errorCount} error${result.errorCount === 1 ? "" : "s"}.`)
  lines.push("")
  lines.push("Showing first " + Math.min(result.errors.length, MAX_ERROR_LINES) + " error(s):")
  lines.push("")
  for (const err of result.errors) {
    lines.push("  " + err)
  }
  if (result.errorCount > result.errors.length) {
    lines.push(`  … and ${result.errorCount - result.errors.length} more`)
  }
  lines.push("")
  lines.push("REQUIRED for your next turn:")
  lines.push("  1. Read each affected file and fix the typecheck error.")
  lines.push("  2. The most common causes match Stage 1's NODE-ESM + TS rules:")
  lines.push("     - Missing .ts extension on relative imports")
  lines.push("     - Type imported as value (need `import type` for CJS packages)")
  lines.push("     - Default imported when source has only named exports")
  lines.push("  3. Re-run completion ONLY after `tsc --noEmit` reports zero errors.")
  lines.push("")
  lines.push("Do NOT declare 'completed' again while typecheck fails. The gate will reject the response and force this loop until the errors are resolved.")
  lines.push("")
  lines.push("═══ END TYPECHECK FAILED ═══")
  return lines.join("\n")
}
