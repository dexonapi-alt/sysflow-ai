import fs from "node:fs/promises"
import path from "node:path"
import { spawn } from "node:child_process"
import { emitAgent, isInkActive } from "./events.js"
import { getShellInvocation } from "./shell.js"
import { remapWindowsShellCommand, detectPowerShellError } from "./win-shell-aliases.js"

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
  // Stage 2 of agent-code-correctness plan: surface stripped imports
  // in the result so the server can inject a loud feedback block to
  // the agent on the next turn. Previously the strips were silent —
  // the agent wrote a file with bare names that no import resolved,
  // didn't know, and hit ReferenceError at runtime later.
  const sanitized = await sanitizeImports(filePath, finalContent)
  const _strippedImports: string[] = sanitized.removed
  if (sanitized.removed.length > 0) {
    finalContent = sanitized.content
  }

  await fs.writeFile(filePath, finalContent, "utf8")

  const { computeDiff, storeDiff } = await import("./diff.js")
  const diff = computeDiff(oldContent, finalContent)
  if (runId && diff.changed) {
    storeDiff(runId, filePath, diff, oldContent, finalContent)
  }

  return {
    success: true,
    diff: diff.changed ? diff : undefined,
    pkgProtected,
    ...(_strippedImports.length > 0 ? { _strippedImports } : {}),
  }
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
  // Stage 2 of agent-code-correctness plan: same loud-feedback path
  // as writeFileTool (see comment there).
  const sanitized = await sanitizeImports(filePath, finalContent)
  const _strippedImports: string[] = sanitized.removed
  if (sanitized.removed.length > 0) {
    finalContent = sanitized.content
  }

  await fs.writeFile(filePath, finalContent, "utf8")

  const { computeDiff, storeDiff } = await import("./diff.js")
  const diff = computeDiff(oldContent, finalContent)
  if (runId && diff.changed) {
    storeDiff(runId, filePath, diff, oldContent, finalContent)
  }

  return {
    success: true,
    diff: diff.changed ? diff : undefined,
    pkgProtected,
    ...(_strippedImports.length > 0 ? { _strippedImports } : {}),
  }
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

    // Pre-Windows-shell-fix this branch spawned cmd.exe and then
    // invoked PowerShell as a nested process to do the actual work.
    // The outer wrapper isn't needed anymore — `getShellInvocation`
    // already routes to PowerShell directly on Windows, so the inner
    // command can be the PowerShell expression itself without the
    // `powershell -NoProfile -Command "..."` indirection.
    const cmd = isWindows
      ? `Get-ChildItem -Path '.' -Recurse -File -Include *.ts,*.tsx,*.js,*.jsx,*.json,*.prisma,*.css,*.html,*.md ${SEARCH_EXCLUDE_DIRS.map(d => `| Where-Object { $_.FullName -notmatch '\\\\${d}\\\\' }`).join(" ")} | Select-String -Pattern '${pattern.replace(/'/g, "''")}' -List | ForEach-Object { $_.Path + ':' + $_.LineNumber + ':' + $_.Line.Trim() }`
      : `grep -rn "${pattern}" "${directory}" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.json" --include="*.prisma" --include="*.css" --include="*.html" ${SEARCH_EXCLUDE_DIRS.map(d => `--exclude-dir="${d}"`).join(" ")} -l`
    const { shell, args: shellArgs } = getShellInvocation(cmd)

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

// Phase 7: install-class commands run in the BACKGROUND so the agent can
// keep working while they finish. Carved out of SLOW_COMMAND_PATTERNS — the
// agent USED to skip these entirely, which meant deps never got installed.
const BACKGROUND_BY_DEFAULT_PATTERNS: RegExp[] = [
  /\bnpm\s+(install|i|ci)\b/,
  /\byarn\s+(install|add)\b/,
  /\bpnpm\s+(install|i|add)\b/,
  /\bbun\s+(install|add|i)\b/,
  /\bpip\s+install\s+-r\b/,
  /\bpip3\s+install\s+-r\b/,
  /\bbundle\s+install\b/,
  /\bcargo\s+build\b/,
  /\bgo\s+mod\s+download\b/,
]

// Commands that are too slow, obsolete, or should be user-run — auto-skip.
// Install commands moved to BACKGROUND_BY_DEFAULT_PATTERNS above.
const SLOW_COMMAND_PATTERNS: RegExp[] = [
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

// ─── Stage 5 of plan 2026-05-18-ui-ux-polish-and-action-aware-spinner.md: live stream preview ───
//
// `createStreamPreviewEmitter()` returns a small stateful helper that
// the run_command child-process handlers feed raw stdout/stderr chunks
// into. The helper maintains a rolling ring of the most-recent
// non-empty stream lines and debounces emission to `tool_stream` events
// — at most one emit every STREAM_DEBOUNCE_MS (default 250ms).
//
// Pre-Stage-5 the agent ran a 30s `npm install` and the user saw only
// the static `● Bash(npm install)` card + the spinner. No progress
// feedback. With this helper the user sees the last 5 lines of stream
// output update live under the running card.
//
// The emitter is intentionally LOCAL to each runCommandTool call
// (closure, not module-level) so multiple parallel commands don't
// pollute each other's previews — though run_command is in the serial
// path so parallel commands shouldn't actually happen.

const STREAM_PREVIEW_LINES = 5
const STREAM_DEBOUNCE_MS = 250

interface StreamPreviewEmitter {
  /** Feed raw stdout/stderr chunk text. Splits on newlines internally. */
  consume(chunk: string): void
  /** Flush any pending emission immediately (called by the close handler). */
  flush(): void
}

// Stage 6 of plan 2026-05-18-ui-ux-polish-and-action-aware-spinner.md:
// per-run latch — true if at least one tool_stream event fired during
// the run. Diagnostic for Stage 5 issue #7's wiring.

let _streamPreviewEverShown = false

export function getStreamPreviewEverShown(): boolean {
  return _streamPreviewEverShown
}

export function resetStreamPreviewEverShown(): void {
  _streamPreviewEverShown = false
}

function createStreamPreviewEmitter(): StreamPreviewEmitter {
  const ring: string[] = []
  let pending = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let lineBuffer = ""

  const emit = (): void => {
    pending = false
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (ring.length === 0) return
    // Stage 6 of plan 2026-05-18-ui-ux-polish-and-action-aware-spinner.md:
    // latch that we emitted at least one stream preview this run.
    _streamPreviewEverShown = true
    emitAgent({ type: "tool_stream", lines: ring.slice() })
  }

  const schedule = (): void => {
    if (pending) return
    pending = true
    timer = setTimeout(emit, STREAM_DEBOUNCE_MS)
  }

  return {
    consume(chunk: string): void {
      if (!chunk) return
      lineBuffer += chunk
      // Drain complete lines from the buffer; keep the unfinished tail.
      const nl = lineBuffer.lastIndexOf("\n")
      if (nl === -1) return
      const complete = lineBuffer.slice(0, nl)
      lineBuffer = lineBuffer.slice(nl + 1)
      for (const raw of complete.split("\n")) {
        const trimmed = raw.replace(/\r$/, "").trim()
        if (trimmed.length === 0) continue
        ring.push(trimmed)
        while (ring.length > STREAM_PREVIEW_LINES) ring.shift()
      }
      schedule()
    },
    flush(): void {
      // If a partial line is in the buffer, surface it too (final emit).
      if (lineBuffer.length > 0) {
        const final = lineBuffer.trim()
        lineBuffer = ""
        if (final.length > 0) {
          ring.push(final)
          while (ring.length > STREAM_PREVIEW_LINES) ring.shift()
        }
      }
      emit()
    },
  }
}

// ─── Stage 5 of awareness-and-verification-correctness plan: Windows shell error counter ───
//
// Bumped each time runCommandTool's close handler detects a PowerShell
// cmdlet-binding error on stderr (FullyQualifiedErrorId, ParameterBinding-
// Exception, etc.). Spike on the per-run total = the model is reaching
// for bash forms PowerShell rejects = Stage 4 + Stage 4.1's command
// rewrite + platform-aware prompt are doing useful work but the model
// still leaks bash. Zero on a Unix run is expected.

let _windowsShellErrorsCaughtThisRun = 0

export function getWindowsShellErrorsCaught(): number {
  return _windowsShellErrorsCaughtThisRun
}

export function resetWindowsShellErrorsCaught(): void {
  _windowsShellErrorsCaughtThisRun = 0
}

function bumpWindowsShellErrorsCaught(): void {
  _windowsShellErrorsCaughtThisRun += 1
}

interface CommandResult {
  stdout: string
  stderr: string
  skipped?: boolean
  timedOut?: boolean
  interactive?: boolean
  message?: string
  verified?: boolean
  /** Phase 7: when true, the command was handed off to JobRegistry; jobId is set. */
  startedBackground?: boolean
  jobId?: string
  status?: "running" | "done" | "failed"
  command?: string
  success?: boolean
  /**
   * Stage 4 of awareness-and-verification-correctness plan: when a
   * Windows Unix-alias remap occurred (e.g. `ls -la` → `Get-ChildItem
   * -Force`), the original command is preserved here so the agent
   * sees what it asked for vs what ran.
   */
  originalCommand?: string
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

export interface RunCommandOptions {
  background?: boolean
  runId?: string
  label?: string
}

export async function runCommandTool(
  command: string,
  cwd: string = process.cwd(),
  opts: RunCommandOptions = {},
): Promise<CommandResult> {
  if (!command) {
    return { stdout: "", stderr: "No command provided", message: "run_command requires a command string." }
  }
  const preprocessed = preprocessCommand(command.trim())
  // Stage 4 of awareness-and-verification-correctness plan: remap
  // Unix-form commands the LLM commonly emits but PowerShell rejects
  // (`ls -la` etc.) into their PowerShell equivalents. On non-Windows
  // platforms this is a no-op. originalCommand is preserved for the
  // result envelope when a remap occurred.
  const { command: trimmed, originalCommand } = remapWindowsShellCommand(preprocessed)
  const isLongRunning = LONG_RUNNING_PATTERNS.some((p) => p.test(trimmed))
  const isSlow = SLOW_COMMAND_PATTERNS.some((p) => p.test(trimmed))
  const matchesBackgroundDefault = BACKGROUND_BY_DEFAULT_PATTERNS.some((p) => p.test(trimmed))
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

  // Phase 7: install-class commands run in the BACKGROUND by default so the
  // agent can keep working. opts.background can force either direction.
  const wantsBackground = opts.background === true || (opts.background !== false && matchesBackgroundDefault)

  // No runId + auto-background install: skip rather than run synchronously
  // (could block for minutes). Caller should re-invoke with a runId.
  if (matchesBackgroundDefault && !opts.runId && opts.background !== false) {
    return {
      stdout: "",
      stderr: "",
      skipped: true,
      message: `SKIPPED (install-class command needs a runId to background): ${command}\n\nThis is a transient routing issue — the runner is missing context to track the job. Continue with other steps.`,
    }
  }

  if (wantsBackground && opts.runId) {
    const { start } = await import("./background-jobs.js")
    try {
      const job = start({ command: trimmed, cwd, runId: opts.runId, label: opts.label || trimmed.slice(0, 60) })
      return {
        stdout: "",
        stderr: "",
        startedBackground: true,
        jobId: job.id,
        status: "running",
        command: trimmed,
        message: `Started in background: ${trimmed}\nJob ID: ${job.id}\nUse check_jobs to poll status. Don't wait — keep working on other steps.`,
      }
    } catch (err) {
      return {
        stdout: "",
        stderr: (err as Error).message,
        success: false,
        message: `Failed to start background job: ${(err as Error).message}`,
      }
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
      const { shell, args: shellArgs } = getShellInvocation(trimmed)
      // Still need the platform flag for `taskkill` on the timeout
      // path further down — separate concern from shell selection.
      const isWindows = process.platform === "win32"

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

      // Forward child output to terminal AND capture for monitoring.
      // Phase 16-fixup (Bug 4): when Ink is active, route the stream through
      // the events bus so the AgentStream renders it in the live region
      // instead of writing raw to stdout — raw writes collide with Ink's
      // reserved region and cause the scroll glitch the user reported.
      child.stdout?.on("data", (d: Buffer) => {
        const text = d.toString()
        stdout += text
        if (isInkActive()) {
          // Strip the trailing newline children love to add so we don't
          // produce empty log entries; split on newlines so each line is a
          // separate log event the reducer can render cleanly.
          for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
            if (line.length > 0) emitAgent({ type: "log", level: "muted", text: line })
          }
        } else {
          process.stdout.write(d)
        }

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
        const text = d.toString()
        if (isInkActive()) {
          for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
            if (line.length > 0) emitAgent({ type: "log", level: "warning", text: line })
          }
        } else {
          process.stderr.write(d)
        }
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
    const { shell, args: shellArgs } = getShellInvocation(trimmed)

    const child = spawn(shell, shellArgs, { cwd, env: { ...process.env, FORCE_COLOR: "0" } })

    let stdout = ""
    let stderr = ""

    // Stage 5 of plan 2026-05-18-ui-ux-polish-and-action-aware-spinner.md
    // (audit issue #7): debounced live preview of the merged stream.
    // Emits the most-recent STREAM_PREVIEW_LINES non-empty lines via
    // a `tool_stream` event so <AgentStream> renders <StreamPreview>
    // under the running ActionCard. 250ms debounce keeps the event rate
    // sane for high-volume tools (npm install, webpack builds).
    const streamPreviewState = createStreamPreviewEmitter()
    child.stdout.on("data", (d: Buffer) => {
      const chunk = d.toString()
      stdout += chunk
      streamPreviewState.consume(chunk)
    })
    child.stderr.on("data", (d: Buffer) => {
      const chunk = d.toString()
      stderr += chunk
      streamPreviewState.consume(chunk)
    })

    const timer = setTimeout(() => {
      child.kill("SIGTERM")
      // Stage 5 (audit issue #7): final flush before resolving the
      // timed-out result so the user sees whatever partial output
      // landed before SIGTERM.
      streamPreviewState.flush()
      resolve({
        stdout: stdout.slice(-2000),
        stderr: stderr.slice(-2000),
        timedOut: true,
        message: `Command timed out after ${COMMAND_TIMEOUT_MS / 1000}s. Partial output included.`
      })
    }, COMMAND_TIMEOUT_MS)

    child.on("close", (code) => {
      clearTimeout(timer)
      // Stage 5 of plan 2026-05-18-ui-ux-polish-and-action-aware-spinner.md
      // (audit issue #7): final flush so any partial-line tail in the
      // stream buffer reaches the UI before the card settles. The
      // reducer clears the preview slot on the next tool_end, so this
      // flush is the last chance for the user to see late output.
      streamPreviewState.flush()
      // Stage 4 of awareness-and-verification-correctness plan:
      // even with exit code 0, treat the command as failed when
      // stderr contains PowerShell cmdlet-binding error markers
      // (FullyQualifiedErrorId, NamedParameterNotFound, etc.). The
      // shell process exited cleanly because `; exit $LASTEXITCODE`
      // saw a stale 0, but the cmdlet itself rejected its args —
      // reporting success would lie to the agent and the user.
      const psError = process.platform === "win32" ? detectPowerShellError(stderr) : { isError: false, marker: null }
      const originalSuffix = originalCommand ? { originalCommand } : {}

      if (code !== 0 && !stdout) {
        reject(new Error(stderr.slice(-500) || `Command exited with code ${code}`))
      } else if (psError.isError) {
        // Stage 5: per-run telemetry — count PowerShell-error catches
        // so we can track Stage 4's safety net firing frequency.
        bumpWindowsShellErrorsCaught()
        resolve({
          stdout: stdout.slice(-4000),
          stderr: stderr.slice(-2000),
          success: false,
          message: `PowerShell command failed (${psError.marker}). ${
            originalCommand
              ? `Original command was "${originalCommand}" — the cli mapped it to "${trimmed}" but PowerShell still rejected it. `
              : ""
          }Rephrase using native PowerShell syntax (e.g. Get-ChildItem instead of ls, Get-Content instead of cat).`,
          ...originalSuffix,
        })
      } else {
        resolve({
          stdout: stdout.slice(-4000),
          stderr: stderr.slice(-2000),
          ...originalSuffix,
        })
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
