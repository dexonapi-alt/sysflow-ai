import fs from "node:fs/promises"
import path from "node:path"
import { spawn } from "node:child_process"

// ─── Web Search ───

interface SearchResult {
  title: string
  snippet: string
  url: string
}

export async function webSearchTool(query: string): Promise<SearchResult[]> {
  const encoded = encodeURIComponent(query)
  const url = `https://html.duckduckgo.com/html/?q=${encoded}`

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10_000)

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; SysflowBot/1.0)"
      },
      signal: controller.signal
    })

    const html = await res.text()

    // Parse DuckDuckGo HTML results
    const results: SearchResult[] = []
    const resultBlocks = html.split(/class="result\s/)

    for (const block of resultBlocks.slice(1, 8)) { // top 7 results
      // Extract title
      const titleMatch = block.match(/class="result__a"[^>]*>([\s\S]*?)<\/a>/)
      const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, "").trim() : ""

      // Extract snippet
      const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\//)
      const snippet = snippetMatch ? snippetMatch[1].replace(/<[^>]+>/g, "").trim() : ""

      // Extract URL
      const urlMatch = block.match(/class="result__url"[^>]*>([\s\S]*?)<\//)
      const resultUrl = urlMatch ? urlMatch[1].replace(/<[^>]+>/g, "").trim() : ""

      if (title || snippet) {
        results.push({ title, snippet, url: resultUrl })
      }
    }

    return results
  } catch (err) {
    // Fallback: try npm registry search for package info
    if (query.includes("npm") || query.includes("npx") || query.includes("install")) {
      return await npmSearchFallback(query)
    }
    return [{ title: "Search failed", snippet: (err as Error).message, url: "" }]
  } finally {
    clearTimeout(timeout)
  }
}

async function npmSearchFallback(query: string): Promise<SearchResult[]> {
  // Extract package name from query
  const pkgMatch = query.match(/([@\w/-]+)/)
  if (!pkgMatch) return []

  const pkg = pkgMatch[1]
  try {
    const res = await fetch(`https://registry.npmjs.org/${pkg}`, {
      signal: AbortSignal.timeout(5000)
    })
    if (!res.ok) return [{ title: `Package ${pkg} not found`, snippet: "Check the package name", url: "" }]

    const data = await res.json() as Record<string, unknown>
    const latest = (data["dist-tags"] as Record<string, string>)?.latest || "unknown"
    const desc = (data.description as string) || ""
    const homepage = (data.homepage as string) || ""

    return [{
      title: `${pkg}@${latest}`,
      snippet: desc,
      url: homepage
    }]
  } catch {
    return []
  }
}

interface DirectoryEntry {
  name: string
  type: "file" | "directory"
}

export async function listDirectoryTool(dirPath: string): Promise<DirectoryEntry[]> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true })
  return entries.map((entry) => ({
    name: entry.name,
    type: entry.isDirectory() ? "directory" as const : "file" as const
  }))
}

export async function fileExistsTool(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

export async function createDirectoryTool(dirPath: string): Promise<boolean> {
  await fs.mkdir(dirPath, { recursive: true })
  return true
}

export interface ReadFileResult {
  content: string
  totalLines: number
  truncated: boolean
  startLine: number
}

const READ_FILE_AUTO_LIMIT = 300   // lines shown when no offset/limit given
const READ_FILE_THRESHOLD = 500    // auto-truncate files larger than this

export async function readFileTool(filePath: string, offset?: number, limit?: number): Promise<ReadFileResult> {
  const raw = await fs.readFile(filePath, "utf8")
  const allLines = raw.split("\n")
  const totalLines = allLines.length

  let startLine: number  // 1-indexed
  let selectedLines: string[]
  let truncated = false

  if (offset != null || limit != null) {
    // Explicit range requested
    startLine = Math.max(1, offset ?? 1)
    const count = limit ?? READ_FILE_AUTO_LIMIT
    const startIdx = startLine - 1
    selectedLines = allLines.slice(startIdx, startIdx + count)
    truncated = (startIdx + count) < totalLines
  } else if (totalLines > READ_FILE_THRESHOLD) {
    // Large file — auto-truncate
    startLine = 1
    selectedLines = allLines.slice(0, READ_FILE_AUTO_LIMIT)
    truncated = true
  } else {
    // Small file — return everything
    startLine = 1
    selectedLines = allLines
    truncated = false
  }

  // Format with line numbers: "  1 | code here"
  const maxLineNum = startLine + selectedLines.length - 1
  const padWidth = String(maxLineNum).length
  const formatted = selectedLines
    .map((line, i) => `${String(startLine + i).padStart(padWidth)} | ${line}`)
    .join("\n")

  const content = truncated
    ? `${formatted}\n\n... (${totalLines - (startLine - 1 + selectedLines.length)} more lines. ${totalLines} total. Use offset/limit to read more.)`
    : formatted

  return { content, totalLines, truncated, startLine }
}

export async function writeFileTool(filePath: string, content: string, runId?: string): Promise<{ success: boolean; diff?: import("./diff.js").DiffResult; pkgProtected?: boolean }> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })

  // Read old content for diff (may not exist)
  let oldContent: string | null = null
  try { oldContent = await fs.readFile(filePath, "utf8") } catch { /* new file */ }

  // ─── Package.json protection: prevent AI from corrupting scaffolded deps ───
  let finalContent = content
  let pkgProtected = false
  if (path.basename(filePath) === "package.json" && oldContent) {
    const merged = protectPackageJson(oldContent, content)
    if (merged) {
      finalContent = merged.content
      pkgProtected = merged.protected
    }
  }

  // ─── Import sanitizer: strip relative imports to non-existent files ───
  const sanitized = await sanitizeImports(filePath, finalContent)
  if (sanitized.removed.length > 0) {
    finalContent = sanitized.content
  }

  await fs.writeFile(filePath, finalContent, "utf8")

  const { computeDiff, storeDiff } = await import("./diff.js")
  const diff = computeDiff(oldContent, finalContent)
  if (runId && diff.changed) {
    storeDiff(runId, filePath, diff, oldContent, finalContent)
  }

  return { success: true, diff: diff.changed ? diff : undefined, pkgProtected }
}

/**
 * Edit file with multiple modes:
 *
 * Mode 1 — Search & Replace (preferred for targeted edits):
 *   { path, search: "old text", replace: "new text" }
 *   Finds exact `search` text in file and replaces with `replace`.
 *   `replace` can be "" to delete the matched text.
 *
 * Mode 2 — Line-level edit:
 *   { path, line_start: 5, line_end: 7, content: "replacement lines" }
 *   Replaces lines 5-7 (1-indexed, inclusive) with `content`.
 *   If `content` is "" or omitted, deletes the lines.
 *
 * Mode 3 — Insert at line:
 *   { path, insert_at: 10, content: "new lines" }
 *   Inserts `content` before line 10 (1-indexed).
 *
 * Mode 4 — Full replacement (legacy, still supported):
 *   { path, patch: "entire file content" }
 */
export interface EditFileArgs {
  path: string
  search?: string
  replace?: string
  line_start?: number
  line_end?: number
  insert_at?: number
  content?: string
  patch?: string
}

export async function editFileTool(
  args: EditFileArgs,
  runId?: string
): Promise<{ success: boolean; diff?: import("./diff.js").DiffResult; pkgProtected?: boolean; error?: string }> {
  const filePath = args.path
  await fs.mkdir(path.dirname(filePath), { recursive: true })

  let oldContent: string | null = null
  try { oldContent = await fs.readFile(filePath, "utf8") } catch { /* new file */ }

  let finalContent: string
  let pkgProtected = false

  // ─── Mode 1: Search & Replace ───
  if (args.search !== undefined && args.search !== null) {
    if (!oldContent) {
      return { success: false, error: `Cannot search/replace in "${filePath}" — file does not exist. Use write_file to create new files.` }
    }
    const searchStr = args.search
    const replaceStr = args.replace ?? ""

    if (!oldContent.includes(searchStr)) {
      // Fuzzy match: try trimmed lines comparison for whitespace tolerance
      const fuzzyResult = fuzzySearchReplace(oldContent, searchStr, replaceStr)
      if (fuzzyResult) {
        finalContent = fuzzyResult
        console.log(`  [edit] search/replace (fuzzy match) in ${filePath}`)
      } else {
        return {
          success: false,
          error: `Search text not found in "${filePath}". The exact text:\n---\n${searchStr.slice(0, 200)}\n---\nwas not found. Read the file first to see current content, then retry with the exact text.`
        }
      }
    } else {
      finalContent = oldContent.replace(searchStr, replaceStr)
      console.log(`  [edit] search/replace in ${filePath}`)
    }
  }
  // ─── Mode 2: Line-level edit ───
  else if (args.line_start !== undefined && args.line_start !== null) {
    if (!oldContent) {
      return { success: false, error: `Cannot edit lines in "${filePath}" — file does not exist. Use write_file to create new files.` }
    }
    const lines = oldContent.split("\n")
    const start = Math.max(1, args.line_start) - 1 // Convert 1-indexed to 0-indexed
    const end = Math.min(lines.length, args.line_end ?? args.line_start) // inclusive
    const replacement = args.content ?? ""
    const newLines = replacement === "" ? [] : replacement.split("\n")

    lines.splice(start, end - start, ...newLines)
    finalContent = lines.join("\n")
    console.log(`  [edit] line ${args.line_start}-${args.line_end ?? args.line_start} in ${filePath}`)
  }
  // ─── Mode 3: Insert at line ───
  else if (args.insert_at !== undefined && args.insert_at !== null) {
    if (!oldContent) {
      return { success: false, error: `Cannot insert into "${filePath}" — file does not exist. Use write_file to create new files.` }
    }
    const lines = oldContent.split("\n")
    const insertIdx = Math.max(0, Math.min(lines.length, (args.insert_at ?? 1) - 1))
    const newLines = (args.content ?? "").split("\n")

    lines.splice(insertIdx, 0, ...newLines)
    finalContent = lines.join("\n")
    console.log(`  [edit] insert at line ${args.insert_at} in ${filePath}`)
  }
  // ─── Mode 4: Full replacement (legacy) ───
  else if (args.patch) {
    finalContent = args.patch
    if (path.basename(filePath) === "package.json" && oldContent) {
      const merged = protectPackageJson(oldContent, args.patch)
      if (merged) {
        finalContent = merged.content
        pkgProtected = merged.protected
      }
    }
  }
  // ─── Mode fallback: content field (some models use this) ───
  else if (args.content) {
    finalContent = args.content
    if (path.basename(filePath) === "package.json" && oldContent) {
      const merged = protectPackageJson(oldContent, args.content)
      if (merged) {
        finalContent = merged.content
        pkgProtected = merged.protected
      }
    }
  }
  else {
    return { success: false, error: `edit_file requires one of: search+replace, line_start, insert_at, patch, or content. None provided.` }
  }

  // ─── Import sanitizer: strip relative imports to non-existent files ───
  const sanitized = await sanitizeImports(filePath, finalContent)
  if (sanitized.removed.length > 0) {
    finalContent = sanitized.content
  }

  await fs.writeFile(filePath, finalContent, "utf8")

  const { computeDiff, storeDiff } = await import("./diff.js")
  const diff = computeDiff(oldContent, finalContent)
  if (runId && diff.changed) {
    storeDiff(runId, filePath, diff, oldContent, finalContent)
  }

  return { success: true, diff: diff.changed ? diff : undefined, pkgProtected }
}

/**
 * Fuzzy search/replace: tolerates whitespace differences.
 * Compares trimmed lines of the search string against the file content.
 */
function fuzzySearchReplace(content: string, search: string, replace: string): string | null {
  const searchLines = search.split("\n").map(l => l.trim()).filter(Boolean)
  if (searchLines.length === 0) return null

  const contentLines = content.split("\n")

  for (let i = 0; i <= contentLines.length - searchLines.length; i++) {
    let match = true
    for (let j = 0; j < searchLines.length; j++) {
      if (contentLines[i + j].trim() !== searchLines[j]) {
        match = false
        break
      }
    }
    if (match) {
      const replaceLines = replace === "" ? [] : replace.split("\n")
      const result = [
        ...contentLines.slice(0, i),
        ...replaceLines,
        ...contentLines.slice(i + searchLines.length)
      ]
      return result.join("\n")
    }
  }

  return null
}

// ─── Package.json Smart Merge ───
// Prevents the AI from corrupting dependency versions set by scaffolding tools.
// When the AI writes to an existing package.json, this function:
// 1. Preserves ALL existing dependency versions (the scaffolded ones are correct)
// 2. Allows NEW dependencies the AI adds (but strips version — user installs them)
// 3. Merges scripts and other non-dep fields from the AI's version
// 4. Keeps the existing structure intact

const DEP_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const

function protectPackageJson(existingRaw: string, newRaw: string): { content: string; protected: boolean } | null {
  let existing: Record<string, unknown>
  let incoming: Record<string, unknown>

  try { existing = JSON.parse(existingRaw) } catch { return null }
  try { incoming = JSON.parse(newRaw) } catch { return null }

  let wasProtected = false
  const merged = { ...existing }

  // Merge top-level non-dep fields (name, version, scripts, etc.)
  for (const key of Object.keys(incoming)) {
    if ((DEP_FIELDS as readonly string[]).includes(key)) continue
    // For scripts: merge new scripts into existing, don't replace
    if (key === "scripts" && existing.scripts && incoming.scripts) {
      merged.scripts = { ...(existing.scripts as Record<string, unknown>), ...(incoming.scripts as Record<string, unknown>) }
    } else if (!(key in existing)) {
      // Only add fields that don't exist yet (don't overwrite name, version, etc.)
      merged[key] = incoming[key]
    }
  }

  // Protect dependency fields: keep existing versions, only add genuinely new packages
  for (const field of DEP_FIELDS) {
    const existingDeps = (existing[field] || {}) as Record<string, string>
    const incomingDeps = (incoming[field] || {}) as Record<string, string>

    if (!incomingDeps || Object.keys(incomingDeps).length === 0) continue

    const protectedDeps = { ...existingDeps }
    let fieldModified = false

    for (const [pkg, version] of Object.entries(incomingDeps)) {
      if (pkg in existingDeps) {
        // Package exists — KEEP the existing version, ignore AI's version
        if (existingDeps[pkg] !== version) {
          wasProtected = true
          console.log(`  [pkg-guard] Blocked version change: ${pkg} "${existingDeps[pkg]}" → "${version}" (keeping original)`)
        }
      } else {
        // New package — add it with "latest" instead of AI's hallucinated version
        protectedDeps[pkg] = "latest"
        fieldModified = true
        console.log(`  [pkg-guard] New dependency: ${pkg} (set to "latest" — user should install)`)
      }
    }

    if (fieldModified || wasProtected) {
      merged[field] = protectedDeps
    }
  }

  if (wasProtected) {
    console.log(`  [pkg-guard] Protected package.json — preserved scaffolded dependency versions`)
  }

  return { content: JSON.stringify(merged, null, 2) + "\n", protected: wasProtected }
}

// ─── Import Sanitizer: strip bad relative imports on write ───

const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs"])

// Batch-aware: files being written in the same batch should not be stripped
let batchWritePaths: Set<string> = new Set()

export function setBatchWritePaths(paths: string[]): void {
  batchWritePaths = new Set(paths.map(p => path.resolve(p)))
}

export function clearBatchWritePaths(): void {
  batchWritePaths = new Set()
}

async function sanitizeImports(filePath: string, content: string): Promise<{ content: string; removed: string[] }> {
  const ext = path.extname(filePath).toLowerCase()
  if (!CODE_EXTENSIONS.has(ext)) return { content, removed: [] }

  const dir = path.dirname(filePath)
  const lines = content.split("\n")
  const cleaned: string[] = []
  const removed: string[] = []

  for (const line of lines) {
    const trimmed = line.trim()
    // Match: import ... from './something' or import './something'
    const importMatch = trimmed.match(/^import\s+(?:.*?\s+from\s+)?['"](\.[^'"]+)['"]/)
    if (!importMatch) {
      cleaned.push(line)
      continue
    }

    const importPath = importMatch[1]
    // Strip Vite/bundler query params (?url, ?raw, ?inline, ?worker, etc.) before resolving
    const cleanImportPath = importPath.split("?")[0]
    const resolved = path.resolve(dir, cleanImportPath)

    // Skip if being created in the same batch
    const resolvedVariants = [
      resolved,
      resolved + ".ts", resolved + ".tsx",
      resolved + ".js", resolved + ".jsx",
    ]
    if (resolvedVariants.some(v => batchWritePaths.has(v))) {
      cleaned.push(line)
      continue
    }

    // Check if the file exists (try with common extensions)
    const candidates = [
      resolved,
      resolved + ".ts", resolved + ".tsx",
      resolved + ".js", resolved + ".jsx",
      path.join(resolved, "index.ts"),
      path.join(resolved, "index.tsx"),
      path.join(resolved, "index.js"),
    ]

    let exists = false
    for (const candidate of candidates) {
      try {
        await fs.access(candidate)
        exists = true
        break
      } catch { /* doesn't exist */ }
    }

    if (exists) {
      cleaned.push(line)
    } else {
      removed.push(importPath)
      console.log(`  [import-sanitizer] Stripped bad import "${importPath}" — file not found`)
    }
  }

  return { content: cleaned.join("\n"), removed }
}

export async function moveFileTool(from: string, to: string): Promise<boolean> {
  await fs.mkdir(path.dirname(to), { recursive: true })
  await fs.rename(from, to)
  return true
}

export async function deleteFileTool(filePath: string): Promise<boolean> {
  const stat = await fs.stat(filePath)
  if (stat.isDirectory()) {
    await fs.rm(filePath, { recursive: true, force: true })
  } else {
    await fs.unlink(filePath)
  }
  return true
}

/** Directories to always skip when searching code */
const SEARCH_EXCLUDE_DIRS = [
  "node_modules", ".git", ".next", ".turbo", "dist", "build",
  ".cache", "coverage", ".output", ".nuxt", ".svelte-kit",
  "sysbase", "sysbase-knowledge", "__pycache__", ".venv"
]

export async function searchCodeTool(directory: string, pattern: string): Promise<string[]> {
  return new Promise((resolve) => {
    const isWindows = process.platform === "win32"
    const shell = isWindows ? "cmd.exe" : "/bin/sh"

    // Use PowerShell on Windows for proper directory exclusion
    // Use grep with --exclude-dir on Linux/Mac
    const cmd = isWindows
      ? `powershell -NoProfile -Command "Get-ChildItem -Path '.' -Recurse -File -Include *.ts,*.tsx,*.js,*.jsx,*.json,*.prisma,*.css,*.html,*.md ${SEARCH_EXCLUDE_DIRS.map(d => `| Where-Object { $_.FullName -notmatch '\\\\${d}\\\\' }`).join(" ")} | Select-String -Pattern '${pattern.replace(/'/g, "''")}' -List | ForEach-Object { $_.Path + ':' + $_.LineNumber + ':' + $_.Line.Trim() }"`
      : `grep -rn "${pattern}" "${directory}" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.json" --include="*.prisma" --include="*.css" --include="*.html" ${SEARCH_EXCLUDE_DIRS.map(d => `--exclude-dir="${d}"`).join(" ")} -l`
    const shellArgs = isWindows ? ["/c", cmd] : ["-c", cmd]

    const child = spawn(shell, shellArgs, { cwd: directory })
    let stdout = ""
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString() })

    // Timeout: if search takes more than 15s, return what we have
    const timer = setTimeout(() => {
      child.kill("SIGTERM")
      const results = stdout.trim().split("\n").filter(Boolean)
      resolve(results.length > 0 ? results : [`(search timed out after 15s — try a more specific pattern)`])
    }, 15_000)

    child.on("close", () => {
      clearTimeout(timer)
      resolve(stdout.trim().split("\n").filter(Boolean))
    })
    child.on("error", () => {
      clearTimeout(timer)
      resolve([])
    })
  })
}

const LONG_RUNNING_PATTERNS = [
  /^npm\s+start/,
  /^npm\s+run\s+(dev|start|serve|watch)/,
  /^npx\s+(nodemon|ts-node-dev|next\s+dev|vite\s+dev|webpack\s+serve)/,
  /^node\s+\S+\.(js|ts|mjs)$/,
  /^python\s+\S+\.py$/,
  /^deno\s+run/,
  /^bun\s+run/
]

// Commands that are too slow, obsolete, or should be user-run — auto-skip
const SLOW_COMMAND_PATTERNS = [
  /npm\s+(install|i|ci)\b/,
  /yarn\s+(install|add)\b/,
  /pnpm\s+(install|i|add)\b/,
  /npx\s+(--yes\s+)?prisma\b/,
  /npx\s+(--yes\s+)?shadcn/,
  /tailwindcss\s+init/,           // removed in Tailwind v4
  /npx\s+(--yes\s+)?tailwindcss/, // no executable in v4
]

// Commands that need interactive terminal (scaffolding tools, prompts)
export const INTERACTIVE_PATTERNS = [
  /^npx\s+(--yes\s+)?create-/,
  /^npm\s+create\s/,
  /^npm\s+init/,
  /^yarn\s+create/,
  /^pnpm\s+create/,
  /^npx\s+(--yes\s+)?@nestjs\/cli\s+new/,
  /^npx\s+(--yes\s+)?@angular\/cli\s+new/,
  /^npx\s+(--yes\s+)?nuxi/,
  /^npx\s+(--yes\s+)?degit/,
  /^npx\s+(--yes\s+)?giget/,
  /^django-admin\s+startproject/,
  /^rails\s+new/,
  /^cargo\s+init/,
  /^dotnet\s+new/
]

const COMMAND_TIMEOUT_MS = 30_000

interface CommandResult {
  stdout: string
  stderr: string
  skipped?: boolean
  timedOut?: boolean
  interactive?: boolean
  message?: string
  verified?: boolean
}

/**
 * Pre-process commands before execution to prevent known issues.
 * - create-vite: add --no-interactive to prevent auto install+dev-server start
 */
function preprocessCommand(cmd: string): string {
  // create-vite without --no-interactive will prompt to install AND start dev server,
  // which hangs the CLI forever. Force non-interactive scaffolding.
  if (/^npx\s+(--yes\s+)?create-vite\b/.test(cmd) && !cmd.includes("--no-interactive")) {
    // Insert --no-interactive right after the package name (before other flags)
    return cmd.replace(/(create-vite(?:@\S+)?)/, "$1 --no-interactive")
  }
  return cmd
}

export async function runCommandTool(command: string, cwd: string = process.cwd()): Promise<CommandResult> {
  if (!command) {
    return { stdout: "", stderr: "No command provided", message: "run_command requires a command string." }
  }
  const trimmed = preprocessCommand(command.trim())
  const isLongRunning = LONG_RUNNING_PATTERNS.some((p) => p.test(trimmed))
  const isSlow = SLOW_COMMAND_PATTERNS.some((p) => p.test(trimmed))
  // Commands with --no-interactive don't need terminal passthrough
  const isInteractive = INTERACTIVE_PATTERNS.some((p) => p.test(trimmed)) && !trimmed.includes("--no-interactive")

  if (isLongRunning) {
    return {
      stdout: "",
      stderr: "",
      skipped: true,
      message: `This is a long-running command (server/watcher). The user should run it manually:\n\n  ${command}\n\nDo NOT attempt to run server-start commands. Instead, tell the user to run it themselves.`
    }
  }

  if (isSlow) {
    return {
      stdout: "",
      stderr: "",
      skipped: true,
      message: `SKIPPED (slow command — user will run manually): ${command}\n\nDo NOT stop or complete because of this skip. CONTINUE creating all project files with write_file. Add this command to your final summary under "Next Steps". The task is NOT done — keep implementing.`
    }
  }

  // Interactive commands: stdin inherited for prompts, stdout/stderr piped for monitoring.
  // We forward output to the terminal AND watch for dev server startup (to auto-kill).
  if (isInteractive) {
    return new Promise((resolve, reject) => {
      const isWindows = process.platform === "win32"
      const shell = isWindows ? "cmd.exe" : "/bin/sh"
      const shellArgs = isWindows ? ["/c", trimmed] : ["-c", trimmed]

      console.log("") // blank line before interactive output

      const child = spawn(shell, shellArgs, {
        cwd,
        stdio: ["inherit", "pipe", "pipe"],
        env: { ...process.env, FORCE_COLOR: "1" }
      })

      let resolved = false
      let stdout = ""
      const MAX_TOTAL_TIME = 600_000 // hard cap at 10 min
      const startTime = Date.now()

      // Dev server patterns: if we see these in output, the scaffolder started a server
      const DEV_SERVER_PATTERNS = [
        /ready in \d+/i,
        /Local:\s+http/i,
        /listening on\s+(port\s+)?\d+/i,
        /started server on/i,
        /compiled\s+(client\s+)?successfully/i,
        /VITE v[\d.]+ ready/i,
        /webpack.*compiled/i,
        /localhost:\d{4}/,
      ]

      // Forward child output to terminal AND capture for monitoring
      child.stdout?.on("data", (d: Buffer) => {
        const text = d.toString()
        stdout += text
        process.stdout.write(d)

        if (DEV_SERVER_PATTERNS.some(p => p.test(text))) {
          // Dev server detected — give it a moment to finish output, then kill
          setTimeout(() => {
            if (!resolved) {
              console.log(`\n  (dev server detected — stopping process to continue task)`)
              killChild("Dev server started inside scaffolder. The project was scaffolded successfully. Do NOT run dev servers — tell the user to start it manually.")
            }
          }, 3000)
        }
      })
      child.stderr?.on("data", (d: Buffer) => {
        process.stderr.write(d)
      })

      const timeoutChecker = setInterval(() => {
        if (resolved) { clearInterval(timeoutChecker); return }
        if (Date.now() - startTime > MAX_TOTAL_TIME) {
          console.log(`\n  (command exceeded 10 minutes — force stopping)`)
          killChild()
        }
      }, 60_000)

      function killChild(msg?: string): void {
        if (resolved) return
        resolved = true
        clearInterval(timeoutChecker)

        if (isWindows) {
          spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" })
        } else {
          child.kill("SIGTERM")
        }

        resolve({
          stdout: stdout.slice(-3000),
          stderr: "",
          timedOut: !msg,
          interactive: true,
          message: msg || `Command timed out after ${Math.round((Date.now() - startTime) / 1000)}s. Check if the project directory was created. If it exists, continue — otherwise create files manually.`
        })
      }

      child.on("close", (code) => {
        if (resolved) return
        resolved = true
        clearInterval(timeoutChecker)

        console.log("") // blank line after interactive output
        if (code !== 0 && code !== null) {
          resolve({
            stdout: stdout.slice(-3000),
            stderr: `Exited with code ${code}`,
            interactive: true,
            message: `Command finished with exit code ${code}. Check the output above for details.`
          })
        } else {
          resolve({
            stdout: stdout.slice(-3000),
            stderr: "",
            interactive: true,
            message: "Command completed successfully."
          })
        }
      })

      child.on("error", (err) => {
        if (resolved) return
        resolved = true
        clearInterval(timeoutChecker)
        reject(err)
      })
    })
  }

  // Normal commands: capture output
  return new Promise((resolve, reject) => {
    const isWindows = process.platform === "win32"
    const shell = isWindows ? "cmd.exe" : "/bin/sh"
    const shellArgs = isWindows ? ["/c", trimmed] : ["-c", trimmed]

    const child = spawn(shell, shellArgs, { cwd, env: { ...process.env, FORCE_COLOR: "0" } })

    let stdout = ""
    let stderr = ""

    child.stdout.on("data", (d: Buffer) => { stdout += d.toString() })
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString() })

    const timer = setTimeout(() => {
      child.kill("SIGTERM")
      resolve({
        stdout: stdout.slice(-2000),
        stderr: stderr.slice(-2000),
        timedOut: true,
        message: `Command timed out after ${COMMAND_TIMEOUT_MS / 1000}s. Partial output included.`
      })
    }, COMMAND_TIMEOUT_MS)

    child.on("close", (code) => {
      clearTimeout(timer)
      if (code !== 0 && !stdout) {
        reject(new Error(stderr.slice(-500) || `Command exited with code ${code}`))
      } else {
        resolve({ stdout: stdout.slice(-4000), stderr: stderr.slice(-2000) })
      }
    })

    child.on("error", (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

// ─── Indexed file search ───

import { getOrBuildIndex, searchIndex, searchByGlob } from "./indexer.js"
import { getSysbasePath } from "../lib/sysbase.js"

export async function searchFilesTool(query: string, glob?: string): Promise<string> {
  const index = await getOrBuildIndex(process.cwd(), getSysbasePath())

  if (glob) {
    const results = searchByGlob(index, glob)
    if (results.length === 0) return `No files matching glob: ${glob}`
    return results.join("\n")
  }

  const results = searchIndex(index, query, 30)
  if (results.length === 0) return `No files matching: ${query}`
  return results.map((r) => r.path).join("\n")
}

// ─── Command Error Recovery ───

interface CommandFix {
  /** Pattern to match against the error message or command */
  match: (cmd: string, error: string) => boolean
  /** Return fixed command, or null if can't fix */
  fix: (cmd: string, error: string) => string | null
  /** Human-readable description of what was fixed */
  description: string
}

/**
 * Known command fixes — ordered by priority.
 * Each entry matches a common error and returns the corrected command.
 */
const KNOWN_COMMAND_FIXES: CommandFix[] = [
  // tailwindcss init removed in v4
  {
    match: (cmd) => /tailwindcss\s+init/i.test(cmd),
    fix: () => null, // no fix — skip entirely
    description: "tailwindcss init was removed in Tailwind v4. Tailwind is configured via postcss.config.js (already set up by create-next-app --tailwind)."
  },
  // shadcn init — should create components manually
  {
    match: (cmd) => /shadcn(-ui)?(@\S+)?\s+init/i.test(cmd),
    fix: () => null,
    description: "shadcn init is slow and interactive. Components should be created manually with write_file."
  },
  // npx without --yes flag
  {
    match: (cmd, err) => cmd.startsWith("npx ") && !cmd.includes("--yes") && (err.includes("Need to install") || err.includes("not found")),
    fix: (cmd) => cmd.replace(/^npx\s+/, "npx --yes "),
    description: "Added --yes flag to auto-accept npx package installation."
  },
  // npm create → npx --yes create-
  {
    match: (cmd) => /^npm\s+create\s+/.test(cmd),
    fix: (cmd) => {
      const pkg = cmd.replace(/^npm\s+create\s+/, "").trim()
      return `npx --yes create-${pkg}`
    },
    description: "Converted npm create to npx --yes create- format."
  },
  // could not determine executable — package doesn't have a bin
  {
    match: (_cmd, err) => err.includes("could not determine executable"),
    fix: () => null,
    description: "Package does not provide an executable. This command should be skipped."
  },
  // ENOENT / command not found
  {
    match: (_cmd, err) => err.includes("ENOENT") || err.includes("not found") || err.includes("not recognized"),
    fix: (cmd) => {
      // Try adding npx --yes prefix if it looks like a CLI tool
      if (!cmd.startsWith("npx") && !cmd.startsWith("npm") && !cmd.startsWith("node")) {
        return `npx --yes ${cmd}`
      }
      return null
    },
    description: "Command not found — trying with npx --yes prefix."
  },
  // Permission denied
  {
    match: (_cmd, err) => err.includes("EACCES") || err.includes("permission denied"),
    fix: (cmd) => {
      if (cmd.startsWith("npm ")) return cmd // npm handles its own permissions
      return null
    },
    description: "Permission error — cannot auto-fix."
  },
  // cd into directory that might not exist yet
  {
    match: (cmd, err) => cmd.startsWith("cd ") && (err.includes("no such file") || err.includes("cannot find")),
    fix: () => null,
    description: "Directory does not exist. The scaffolding command may not have created it."
  },
  // Chained commands where the first part (cd) fails
  {
    match: (cmd, err) => cmd.includes("&&") && (err.includes("no such file") || err.includes("cannot find") || err.includes("not recognized")),
    fix: (cmd) => {
      // Try just the second part of the chain
      const parts = cmd.split("&&").map((p) => p.trim())
      if (parts.length >= 2) return parts[parts.length - 1]
      return null
    },
    description: "Chained command failed — trying the last part only."
  },
  // prisma commands — should be skipped
  {
    match: (cmd) => /prisma\s+(init|migrate|generate|db)/i.test(cmd),
    fix: () => null,
    description: "Prisma commands should be run by the user. Create schema.prisma manually with write_file."
  },
]

export interface CommandRecoveryResult {
  /** Whether a fix was found and should be attempted */
  action: "auto_fix" | "skip" | "web_search" | "ask_user"
  /** The fixed command (only for auto_fix) */
  fixedCommand?: string
  /** Description of what happened */
  description: string
  /** Web search query (only for web_search) */
  searchQuery?: string
}

/**
 * Attempt to recover from a command error using a fallback chain:
 * 1. Known fixes (pattern matching)
 * 2. Auto-fix heuristics
 * 3. Web search suggestion
 * 4. Ask user (last resort)
 */
export function recoverFromCommandError(cmd: string, error: string): CommandRecoveryResult {
  // Step 1: Check known fixes
  for (const fix of KNOWN_COMMAND_FIXES) {
    if (fix.match(cmd, error)) {
      const fixedCmd = fix.fix(cmd, error)
      if (fixedCmd) {
        return { action: "auto_fix", fixedCommand: fixedCmd, description: fix.description }
      }
      // Known issue but no fix — skip
      return { action: "skip", description: fix.description }
    }
  }

  // Step 2: Web search for unknown errors
  // Build a search query from the command and error
  const shortError = error.split("\n")[0].slice(0, 100)
  const searchQuery = `${cmd.split(" ").slice(0, 3).join(" ")} error "${shortError}"`
  return {
    action: "web_search",
    description: `Unknown error. Searching the web for: ${searchQuery}`,
    searchQuery
  }
}

/**
 * Try to find a corrected command via web search.
 * Returns the suggested command or null if search fails.
 */
export async function searchForCommandFix(cmd: string, error: string): Promise<string | null> {
  const shortCmd = cmd.split(" ").slice(0, 4).join(" ")
  const query = `${shortCmd} correct command 2025`

  try {
    const results = await webSearchTool(query)
    if (results.length === 0) return null

    // Look for a command in the search results
    for (const result of results.slice(0, 3)) {
      const text = `${result.title} ${result.snippet}`
      // Find npx/npm commands in the text
      const cmdMatch = text.match(/`?(npx\s+[^`\n]+|npm\s+[^`\n]+)`?/)
      if (cmdMatch) {
        const candidate = cmdMatch[1].trim().replace(/`/g, "")
        // Sanity check: must be a plausible command
        if (candidate.length > 5 && candidate.length < 200) {
          return candidate
        }
      }
    }
    return null
  } catch {
    return null
  }
}

// ─── Diff (delegates to diff engine) ───

import { computeDiff, formatDiffColored, getLastDiff, getRunDiffs, clearRunDiffs } from "./diff.js"
export { computeDiff, formatDiffColored, getLastDiff, getRunDiffs, clearRunDiffs }

export function computeLineDiff(oldContent: string | null, newContent: string): { added: number; removed: number } {
  const result = computeDiff(oldContent, newContent)
  return { added: result.added, removed: result.removed }
}

export async function scanDirectoryTree(dirPath: string, prefix: string = ""): Promise<DirectoryEntry[]> {
  const tree: DirectoryEntry[] = []
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true })
    const sorted = entries
      .filter((e) => !e.name.startsWith(".") && e.name !== "node_modules" && e.name !== "sysbase")
      .sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1
        if (!a.isDirectory() && b.isDirectory()) return 1
        return a.name.localeCompare(b.name)
      })

    for (const entry of sorted) {
      const fullPath = path.join(dirPath, entry.name)
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name

      if (entry.isDirectory()) {
        tree.push({ name: relativePath, type: "directory" })
        const children = await scanDirectoryTree(fullPath, relativePath)
        tree.push(...children)
      } else {
        tree.push({ name: relativePath, type: "file" })
      }
    }
  } catch {
    // directory doesn't exist or can't be read
  }
  return tree
}
