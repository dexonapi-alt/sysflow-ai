/**
 * Per-file lint checker — runs after every write/edit to catch errors early.
 *
 * Two modes:
 * 1. Quick check (< 200ms): syntax validation + import resolution for a single file
 * 2. Full check (tsc): TypeScript type checking, runs after batches or on-demand
 *
 * Results are shown in CLI and fed back to the AI so it can fix errors before proceeding.
 */

import fs from "node:fs/promises"
import path from "node:path"
import { spawn } from "node:child_process"
import chalk from "chalk"

// ─── Types ───

export interface LintError {
  file: string
  line: number
  column: number
  message: string
  severity: "error" | "warning"
  code?: string     // e.g. "TS2304"
}

export interface LintResult {
  file: string
  passed: boolean
  errors: LintError[]
  duration: number
}

// ─── Project detection cache ───

let cachedProjectRoot: string | null = null
let cachedHasTsConfig = false
let cachedHasNodeModules = false

async function detectProjectOnce(cwd: string): Promise<void> {
  if (cachedProjectRoot === cwd) return
  cachedProjectRoot = cwd
  try { await fs.access(path.join(cwd, "tsconfig.json")); cachedHasTsConfig = true } catch { cachedHasTsConfig = false }
  try { await fs.access(path.join(cwd, "node_modules")); cachedHasNodeModules = true } catch { cachedHasNodeModules = false }
}

// ─── Quick single-file checks ───

const LINTABLE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs", ".cts", ".cjs"])

function isLintable(filePath: string): boolean {
  return LINTABLE_EXTENSIONS.has(path.extname(filePath).toLowerCase())
}

/**
 * Check a single file for common issues after write/edit.
 * Fast enough to run after every operation (< 100ms).
 */
async function quickCheck(filePath: string): Promise<LintError[]> {
  const errors: LintError[] = []

  let content: string
  try {
    content = await fs.readFile(filePath, "utf8")
  } catch {
    return errors
  }

  const lines = content.split("\n")

  // Check relative imports resolve to existing files
  const importRegex = /(?:import\s+(?:[\w{},*\s]+\s+from\s+)?['"](\.[^'"]+)['"]|require\s*\(\s*['"](\.[^'"]+)['"]\s*\))/g
  let match: RegExpExecArray | null
  const dir = path.dirname(filePath)

  while ((match = importRegex.exec(content)) !== null) {
    const importPath = match[1] || match[2]
    if (!importPath) continue

    const resolved = path.resolve(dir, importPath)
    const exists = await resolveImport(resolved)
    if (!exists) {
      // Find line number
      const charIdx = match.index
      let lineNum = 1
      for (let i = 0; i < charIdx && i < content.length; i++) {
        if (content[i] === "\n") lineNum++
      }
      errors.push({
        file: filePath,
        line: lineNum,
        column: 0,
        message: `Cannot resolve import "${importPath}" — file not found`,
        severity: "error",
        code: "IMPORT"
      })
    }
  }

  // Check for obvious syntax issues
  // Unmatched JSX tags (basic check for React files)
  const ext = path.extname(filePath).toLowerCase()
  if (ext === ".tsx" || ext === ".jsx") {
    // Check for common JSX errors: unclosed tags, missing closing brackets
    let openBraces = 0
    let openParens = 0
    let openBrackets = 0
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      // Skip strings and comments (basic)
      const cleaned = line.replace(/\/\/.*$/, "").replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/`(?:[^`\\]|\\.)*`/g, "``")
      for (const ch of cleaned) {
        if (ch === "{") openBraces++
        if (ch === "}") openBraces--
        if (ch === "(") openParens++
        if (ch === ")") openParens--
        if (ch === "[") openBrackets++
        if (ch === "]") openBrackets--
      }
    }

    if (openBraces !== 0) {
      errors.push({ file: filePath, line: lines.length, column: 0, message: `Unmatched braces: ${openBraces > 0 ? `${openBraces} unclosed "{"` : `${-openBraces} extra "}"`}`, severity: "error", code: "SYNTAX" })
    }
    if (openParens !== 0) {
      errors.push({ file: filePath, line: lines.length, column: 0, message: `Unmatched parentheses: ${openParens > 0 ? `${openParens} unclosed "("` : `${-openParens} extra ")"`}`, severity: "error", code: "SYNTAX" })
    }
    if (openBrackets !== 0) {
      errors.push({ file: filePath, line: lines.length, column: 0, message: `Unmatched brackets: ${openBrackets > 0 ? `${openBrackets} unclosed "["` : `${-openBrackets} extra "]"`}`, severity: "error", code: "SYNTAX" })
    }
  }

  // Empty file check
  if (content.trim().length === 0 && LINTABLE_EXTENSIONS.has(ext)) {
    errors.push({ file: filePath, line: 1, column: 0, message: "File is empty", severity: "warning", code: "EMPTY" })
  }

  return errors
}

async function resolveImport(resolved: string): Promise<boolean> {
  const extensions = ["", ".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs", ".json"]
  for (const ext of extensions) {
    try { await fs.access(resolved + ext); return true } catch { /* try next */ }
  }
  // Check for index files
  for (const idx of ["index.ts", "index.tsx", "index.js", "index.jsx"]) {
    try { await fs.access(path.join(resolved, idx)); return true } catch { /* try next */ }
  }
  return false
}

// ─── TypeScript type checking ───

// Debounce tsc: don't run more than once per 10 seconds
let lastTscRun = 0
let lastTscErrors: LintError[] = []
const TSC_COOLDOWN_MS = 10_000

/**
 * Run TypeScript compiler on the project and return errors for specific files.
 * Debounced: won't re-run within TSC_COOLDOWN_MS of last run.
 */
async function runTsc(cwd: string, targetFiles?: string[]): Promise<LintError[]> {
  const now = Date.now()
  if (now - lastTscRun < TSC_COOLDOWN_MS && lastTscErrors.length >= 0) {
    // Return cached results filtered to target files
    if (targetFiles && targetFiles.length > 0) {
      const normalizedTargets = new Set(targetFiles.map(f => path.resolve(cwd, f).replace(/\\/g, "/")))
      return lastTscErrors.filter(e => normalizedTargets.has(path.resolve(cwd, e.file).replace(/\\/g, "/")))
    }
    return lastTscErrors
  }

  return new Promise<LintError[]>((resolve) => {
    const errors: LintError[] = []
    let output = ""

    const proc = spawn("npx", ["tsc", "--noEmit", "--pretty", "false"], {
      cwd,
      shell: true,
      timeout: 20_000,
      stdio: ["ignore", "pipe", "pipe"]
    })

    proc.stdout?.on("data", (data: Buffer) => { output += data.toString() })
    proc.stderr?.on("data", (data: Buffer) => { output += data.toString() })

    proc.on("close", () => {
      lastTscRun = Date.now()

      // Parse tsc output: "src/app.ts(5,10): error TS2304: Cannot find name 'x'."
      const errorPattern = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/gm
      let match: RegExpExecArray | null

      while ((match = errorPattern.exec(output)) !== null) {
        errors.push({
          file: match[1].replace(/\\/g, "/"),
          line: parseInt(match[2]),
          column: parseInt(match[3]),
          message: match[6].trim(),
          severity: match[4] as "error" | "warning",
          code: match[5]
        })
      }

      lastTscErrors = errors

      // Filter to target files if specified
      if (targetFiles && targetFiles.length > 0) {
        const normalizedTargets = new Set(targetFiles.map(f => path.resolve(cwd, f).replace(/\\/g, "/")))
        resolve(errors.filter(e => normalizedTargets.has(path.resolve(cwd, e.file).replace(/\\/g, "/"))))
      } else {
        resolve(errors)
      }
    })

    proc.on("error", () => {
      lastTscRun = Date.now()
      resolve([])
    })
  })
}

// ─── Public API ───

/**
 * Lint a single file after write/edit. Runs quick checks immediately,
 * and TypeScript type checking if available.
 *
 * Returns errors found in this file specifically.
 */
export async function lintFile(filePath: string, cwd: string): Promise<LintResult> {
  const start = Date.now()
  if (!isLintable(filePath)) {
    return { file: filePath, passed: true, errors: [], duration: 0 }
  }

  const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath)

  // Quick checks (always run, fast)
  const quickErrors = await quickCheck(absPath)

  // TypeScript check (if project supports it)
  let tscErrors: LintError[] = []
  await detectProjectOnce(cwd)
  if (cachedHasTsConfig && cachedHasNodeModules) {
    tscErrors = await runTsc(cwd, [filePath])
  }

  const allErrors = [...quickErrors, ...tscErrors]
  const duration = Date.now() - start

  return {
    file: filePath,
    passed: allErrors.length === 0,
    errors: allErrors,
    duration
  }
}

/**
 * Lint multiple files after a batch write. Runs quick checks on all files,
 * plus TypeScript check filtered to written files.
 */
export async function lintFiles(filePaths: string[], cwd: string): Promise<LintResult[]> {
  const lintable = filePaths.filter(isLintable)
  if (lintable.length === 0) return []

  const results: LintResult[] = []

  // Quick checks in parallel
  const quickResults = await Promise.all(
    lintable.map(async (fp) => {
      const absPath = path.isAbsolute(fp) ? fp : path.resolve(cwd, fp)
      const errors = await quickCheck(absPath)
      return { file: fp, errors }
    })
  )

  // TypeScript check (single run, filtered to all written files)
  await detectProjectOnce(cwd)
  let tscErrors: LintError[] = []
  if (cachedHasTsConfig && cachedHasNodeModules) {
    tscErrors = await runTsc(cwd, lintable)
  }

  // Merge results per file
  for (const qr of quickResults) {
    const fileTscErrors = tscErrors.filter(e => {
      const normalized = path.resolve(cwd, e.file).replace(/\\/g, "/")
      const target = path.resolve(cwd, qr.file).replace(/\\/g, "/")
      return normalized === target
    })
    const allErrors = [...qr.errors, ...fileTscErrors]
    results.push({
      file: qr.file,
      passed: allErrors.length === 0,
      errors: allErrors,
      duration: 0
    })
  }

  return results
}

/**
 * Force a fresh TypeScript check (ignores debounce cooldown).
 */
export function resetTscCache(): void {
  lastTscRun = 0
  lastTscErrors = []
}

// ─── CLI Display ───

/**
 * Display lint errors in the CLI with file:line:column format.
 * Shows both to the user and returns formatted strings for the AI.
 */
export function displayLintErrors(results: LintResult[]): string[] {
  const messages: string[] = []

  for (const result of results) {
    if (result.passed) continue

    for (const err of result.errors) {
      const location = `${err.file}:${err.line}:${err.column}`
      const codeTag = err.code ? chalk.dim(`[${err.code}]`) : ""
      const severityColor = err.severity === "error" ? chalk.red : chalk.yellow
      const severityIcon = err.severity === "error" ? "✖" : "⚠"

      // CLI display (colored)
      console.log(`    ${severityColor(severityIcon)} ${chalk.white(location)} ${codeTag} ${err.message}`)

      // Plain text for AI
      messages.push(`${err.severity.toUpperCase()}: ${err.file}:${err.line}:${err.column} ${err.code ? `[${err.code}] ` : ""}${err.message}`)
    }
  }

  return messages
}
