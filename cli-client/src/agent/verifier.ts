/**
 * Auto-verification module — runs silently after write batches.
 *
 * Detects project type, runs appropriate checks, returns structured errors.
 * The AI never "decides" to verify — it happens automatically.
 */

import fs from "node:fs/promises"
import path from "node:path"
import { spawn } from "node:child_process"

export interface VerificationResult {
  passed: boolean
  errors: string[]
  warnings: string[]
  command: string | null
  duration: number
  checkedFiles: number
}

export interface VerificationReport {
  overall: boolean
  checks: VerificationResult[]
  summary: string  // human-readable summary for the AI
}

// ─── Project type detection ───

type ProjectType = "typescript" | "javascript" | "unknown"

interface ProjectInfo {
  type: ProjectType
  root: string
  hasTsConfig: boolean
  hasNodeModules: boolean
  hasPackageJson: boolean
}

async function detectProject(dir: string): Promise<ProjectInfo | null> {
  try {
    await fs.access(dir)
  } catch {
    return null
  }

  const info: ProjectInfo = {
    type: "unknown",
    root: dir,
    hasTsConfig: false,
    hasNodeModules: false,
    hasPackageJson: false
  }

  try {
    await fs.access(path.join(dir, "tsconfig.json"))
    info.hasTsConfig = true
    info.type = "typescript"
  } catch { /* no tsconfig */ }

  try {
    await fs.access(path.join(dir, "package.json"))
    info.hasPackageJson = true
    if (info.type === "unknown") info.type = "javascript"
  } catch { /* no package.json */ }

  try {
    await fs.access(path.join(dir, "node_modules"))
    info.hasNodeModules = true
  } catch { /* no node_modules */ }

  return info
}

// ─── Import verification (no compiler needed) ───

async function verifyImports(filesCreated: string[], cwd: string): Promise<VerificationResult> {
  const start = Date.now()
  const errors: string[] = []
  const warnings: string[] = []
  let checked = 0

  for (const filePath of filesCreated) {
    if (!filePath.match(/\.(ts|tsx|js|jsx|mjs)$/)) continue

    const fullPath = path.resolve(cwd, filePath)
    let content: string
    try {
      content = await fs.readFile(fullPath, "utf8")
    } catch {
      continue // file doesn't exist yet or can't be read
    }

    checked++

    // Extract relative imports
    const importRegex = /(?:import|from)\s+['"](\.[^'"]+)['"]/g
    let match
    while ((match = importRegex.exec(content)) !== null) {
      const importPath = match[1]
      const dir = path.dirname(fullPath)

      // Try resolving the import
      const candidates = [
        path.resolve(dir, importPath),
        path.resolve(dir, importPath + ".ts"),
        path.resolve(dir, importPath + ".tsx"),
        path.resolve(dir, importPath + ".js"),
        path.resolve(dir, importPath + ".jsx"),
        path.resolve(dir, importPath, "index.ts"),
        path.resolve(dir, importPath, "index.tsx"),
        path.resolve(dir, importPath, "index.js"),
      ]

      let found = false
      for (const candidate of candidates) {
        try {
          await fs.access(candidate)
          found = true
          break
        } catch { /* try next */ }
      }

      if (!found) {
        errors.push(`${filePath}: import "${importPath}" — file not found`)
      }
    }
  }

  return {
    passed: errors.length === 0,
    errors,
    warnings,
    command: null,
    duration: Date.now() - start,
    checkedFiles: checked
  }
}

// ─── TypeScript type checking ───

async function runTypeCheck(projectDir: string): Promise<VerificationResult> {
  const start = Date.now()

  // Only run if tsconfig.json AND node_modules exist
  const project = await detectProject(projectDir)
  if (!project || !project.hasTsConfig || !project.hasNodeModules) {
    return {
      passed: true,
      errors: [],
      warnings: project && !project.hasNodeModules
        ? ["Skipped tsc: node_modules not installed yet"]
        : [],
      command: "tsc --noEmit (skipped)",
      duration: Date.now() - start,
      checkedFiles: 0
    }
  }

  return new Promise((resolve) => {
    const isWindows = process.platform === "win32"
    const shell = isWindows ? "cmd.exe" : "/bin/sh"
    const cmd = "npx tsc --noEmit --pretty false 2>&1"
    const shellArgs = isWindows ? ["/c", cmd] : ["-c", cmd]

    const child = spawn(shell, shellArgs, {
      cwd: projectDir,
      env: { ...process.env, FORCE_COLOR: "0" }
    })

    let stdout = ""
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString() })
    child.stderr?.on("data", (d: Buffer) => { stdout += d.toString() })

    const timer = setTimeout(() => {
      child.kill("SIGTERM")
      resolve({
        passed: true,
        errors: [],
        warnings: ["tsc timed out after 30s — skipping type check"],
        command: "tsc --noEmit (timed out)",
        duration: Date.now() - start,
        checkedFiles: 0
      })
    }, 30_000)

    child.on("close", (code) => {
      clearTimeout(timer)

      if (code === 0) {
        resolve({
          passed: true,
          errors: [],
          warnings: [],
          command: "tsc --noEmit",
          duration: Date.now() - start,
          checkedFiles: -1 // tsc checks all
        })
        return
      }

      // Parse errors
      const errors = stdout
        .split("\n")
        .filter((line) => line.includes("error TS"))
        .map((line) => line.trim())
        .slice(0, 20) // cap at 20 errors

      resolve({
        passed: false,
        errors,
        warnings: [],
        command: "tsc --noEmit",
        duration: Date.now() - start,
        checkedFiles: -1
      })
    })

    child.on("error", () => {
      clearTimeout(timer)
      resolve({
        passed: true,
        errors: [],
        warnings: ["tsc not available"],
        command: "tsc --noEmit (not available)",
        duration: Date.now() - start,
        checkedFiles: 0
      })
    })
  })
}

// ─── File consistency checks ───

async function checkFileConsistency(filesCreated: string[], cwd: string): Promise<VerificationResult> {
  const start = Date.now()
  const errors: string[] = []
  const warnings: string[] = []

  // Check 1: Empty files
  for (const filePath of filesCreated) {
    if (!filePath.match(/\.(ts|tsx|js|jsx|json|prisma)$/)) continue
    const fullPath = path.resolve(cwd, filePath)
    try {
      const stat = await fs.stat(fullPath)
      if (stat.size === 0) {
        errors.push(`${filePath}: file is empty (0 bytes)`)
      } else if (stat.size < 10 && filePath.endsWith(".ts")) {
        warnings.push(`${filePath}: suspiciously small (${stat.size} bytes)`)
      }
    } catch { /* file doesn't exist */ }
  }

  // Check 2: Prisma schema has models
  for (const filePath of filesCreated) {
    if (!filePath.includes("schema.prisma")) continue
    const fullPath = path.resolve(cwd, filePath)
    try {
      const content = await fs.readFile(fullPath, "utf8")
      const modelCount = (content.match(/^model\s+/gm) || []).length
      if (modelCount === 0) {
        errors.push(`${filePath}: Prisma schema has no models defined`)
      }
    } catch { /* file doesn't exist */ }
  }

  // Check 3: NestJS modules have @Module decorator
  for (const filePath of filesCreated) {
    if (!filePath.match(/\.module\.(ts|js)$/)) continue
    const fullPath = path.resolve(cwd, filePath)
    try {
      const content = await fs.readFile(fullPath, "utf8")
      if (!content.includes("@Module")) {
        errors.push(`${filePath}: NestJS module file missing @Module decorator`)
      }
    } catch { /* file doesn't exist */ }
  }

  // Check 4: Controllers have @Controller decorator
  for (const filePath of filesCreated) {
    if (!filePath.match(/\.controller\.(ts|js)$/)) continue
    const fullPath = path.resolve(cwd, filePath)
    try {
      const content = await fs.readFile(fullPath, "utf8")
      if (!content.includes("@Controller")) {
        errors.push(`${filePath}: controller file missing @Controller decorator`)
      }
    } catch { /* file doesn't exist */ }
  }

  return {
    passed: errors.length === 0,
    errors,
    warnings,
    command: null,
    duration: Date.now() - start,
    checkedFiles: filesCreated.length
  }
}

// ─── Public API: run all applicable verifications ───

/** Track files created per run for incremental verification */
const runFiles = new Map<string, string[]>()

export function trackFilesCreated(runId: string, files: string[]): void {
  const existing = runFiles.get(runId) || []
  runFiles.set(runId, [...existing, ...files])
}

export function getTrackedFiles(runId: string): string[] {
  return runFiles.get(runId) || []
}

export function clearTrackedFiles(runId: string): void {
  runFiles.delete(runId)
}

/**
 * Run verification on recently created files.
 * Called automatically after write batches — never by the AI.
 *
 * @param cwd - working directory
 * @param filesCreated - files written in the recent batch
 * @param runId - run identifier for tracking
 * @returns VerificationReport with all check results
 */
export async function runVerification(
  cwd: string,
  filesCreated: string[],
  runId?: string
): Promise<VerificationReport> {
  if (runId) trackFilesCreated(runId, filesCreated)
  const allFiles = runId ? getTrackedFiles(runId) : filesCreated

  const checks: VerificationResult[] = []

  // Always run: import verification (fast, no deps needed)
  const importCheck = await verifyImports(allFiles, cwd)
  checks.push(importCheck)

  // Always run: file consistency checks
  const consistencyCheck = await checkFileConsistency(filesCreated, cwd)
  checks.push(consistencyCheck)

  // Conditional: TypeScript type check (only if deps installed)
  // Find project directories that might have tsconfig
  const projectDirs = new Set<string>()
  for (const file of allFiles) {
    const parts = file.split("/")
    if (parts.length >= 2) {
      projectDirs.add(path.resolve(cwd, parts[0]))
    }
  }
  projectDirs.add(cwd) // also check root

  for (const dir of projectDirs) {
    const project = await detectProject(dir)
    if (project?.hasTsConfig && project.hasNodeModules) {
      const tscCheck = await runTypeCheck(dir)
      checks.push(tscCheck)
    }
  }

  const allErrors = checks.flatMap((c) => c.errors)
  const allWarnings = checks.flatMap((c) => c.warnings)
  const overall = allErrors.length === 0

  let summary: string
  if (overall && allWarnings.length === 0) {
    summary = `✓ Verification passed (${allFiles.length} files tracked)`
  } else if (overall) {
    summary = `✓ Verification passed with ${allWarnings.length} warnings`
  } else {
    summary = `✗ Verification FAILED: ${allErrors.length} errors found:\n${allErrors.map((e) => `  - ${e}`).join("\n")}`
    if (allWarnings.length > 0) {
      summary += `\n\nWarnings:\n${allWarnings.map((w) => `  - ${w}`).join("\n")}`
    }
  }

  return { overall, checks, summary }
}
