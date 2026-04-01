/**
 * Error-Aware Fix — guides the AI to fix errors reliably.
 *
 * Instead of trying to fix errors programmatically (which is brittle),
 * this system:
 * 1. Parses the error to extract the source file and broken import
 * 2. Forces the AI's first action to read_file (so it sees actual content)
 * 3. Injects ultra-specific instructions telling the AI exactly what to fix
 * 4. The AI uses edit_file search/replace to make the targeted fix
 *
 * This is more reliable because the AI adapts to actual file content,
 * while the system prevents it from hallucinating (creating dirs, rewriting files, etc.)
 */

import type { NormalizedResponse } from "../types.js"

// ─── Types ───

export interface ErrorContext {
  type: "import-error" | "module-not-found" | "generic"
  sourceFile: string
  targetImport: string
  description: string
}

// ─── Pending error context per run ───

const pendingErrors = new Map<string, ErrorContext>()

// ─── Error Detection ───

const IMPORT_ERROR_PATTERNS: Array<{
  pattern: RegExp
  extract: (match: RegExpMatchArray, prompt: string) => { sourceFile: string; targetImport: string } | null
}> = [
  {
    // Vite: Failed to resolve import ../assets/dashboard-preview.png from src/components/Foo.tsx. Does the file exist?
    // Greedy \S+ captures everything including trailing punctuation — cleanPath strips it
    pattern: /Failed to resolve import\s+["']?(\S+?)["']?\s+from\s+(\S+)/i,
    extract: (m) => ({ targetImport: m[1], sourceFile: m[2] })
  },
  {
    // Webpack: Module not found: Can't resolve './Icon' in '/path/to/src/components'
    pattern: /Module not found:.*resolve\s+['"]([^'"]+)['"]\s+in\s+['"]([^'"]+)['"]/i,
    extract: (m) => {
      const dir = m[2].replace(/\\/g, "/")
      const srcIndex = dir.indexOf("src/")
      const sourceDir = srcIndex >= 0 ? dir.slice(srcIndex) : dir
      return { targetImport: m[1], sourceFile: sourceDir }
    }
  },
  {
    // TypeScript: Cannot find module './Icon' or its corresponding type declarations
    pattern: /Cannot find module\s+['"](\.[^'"]+)['"]/i,
    extract: (m, prompt) => {
      const fileMatch = prompt.match(/(?:in|from|at)\s+['"]?(\S+\.(?:tsx?|jsx?))['"]?/i)
      if (fileMatch) return { targetImport: m[1], sourceFile: cleanPath(fileMatch[1]) }
      return null
    }
  },
]

/** Clean a captured path: remove quotes, trailing punctuation, normalize slashes */
function cleanPath(raw: string): string {
  return raw
    .replace(/["']/g, "")
    .replace(/[.,;:!?)}\]]+$/, "")
    .replace(/\\/g, "/")
    .trim()
}

/**
 * Detect if the user's error prompt contains a fixable import error.
 * Returns the parsed error context and a forced read_file action.
 */
export function detectErrorContext(prompt: string): { ctx: ErrorContext; firstAction: NormalizedResponse } | null {
  for (const ep of IMPORT_ERROR_PATTERNS) {
    const match = prompt.match(ep.pattern)
    if (match) {
      const extracted = ep.extract(match, prompt)
      if (!extracted) continue

      const sourceFile = cleanPath(extracted.sourceFile)
      const targetImport = cleanPath(extracted.targetImport)
      if (!sourceFile.includes("/")) continue

      const ctx: ErrorContext = {
        type: "import-error",
        sourceFile,
        targetImport,
        description: `Remove broken import "${targetImport}" from ${sourceFile}`
      }

      console.log(`[error-aware] Detected import error: "${targetImport}" in "${sourceFile}"`)

      return {
        ctx,
        firstAction: {
          kind: "needs_tool",
          tool: "read_file",
          args: { path: sourceFile },
          content: `Reading ${sourceFile} to find and fix the broken import.`,
          reasoning: `The import "${targetImport}" doesn't exist. Reading the file first to see its actual content, then will use edit_file search/replace to remove the bad import line.`,
          usage: { inputTokens: 0, outputTokens: 0 }
        }
      }
    }
  }

  return null
}

/**
 * Detect ALL import errors from a prompt (not just the first).
 * Returns deduplicated list of errors grouped by source file.
 */
export function detectAllErrors(prompt: string): ErrorContext[] {
  const errors: ErrorContext[] = []
  const seen = new Set<string>() // dedup key: "sourceFile::targetImport"

  for (const ep of IMPORT_ERROR_PATTERNS) {
    // Use matchAll to find every occurrence, not just the first
    const regex = new RegExp(ep.pattern.source, ep.pattern.flags.includes("g") ? ep.pattern.flags : ep.pattern.flags + "g")
    for (const match of prompt.matchAll(regex)) {
      const extracted = ep.extract(match as RegExpMatchArray, prompt)
      if (!extracted) continue

      const sourceFile = cleanPath(extracted.sourceFile)
      const targetImport = cleanPath(extracted.targetImport)
      if (!sourceFile.includes("/")) continue

      const key = `${sourceFile}::${targetImport}`
      if (seen.has(key)) continue
      seen.add(key)

      errors.push({
        type: "import-error",
        sourceFile,
        targetImport,
        description: `Remove broken import "${targetImport}" from ${sourceFile}`
      })
    }
  }

  return errors
}

// ─── Pending error queue for multi-error prompts ───

const pendingErrorQueues = new Map<string, ErrorContext[]>()

export function setPendingErrorQueue(runId: string, errors: ErrorContext[]): void {
  pendingErrorQueues.set(runId, errors)
}

export function popNextPendingError(runId: string): ErrorContext | null {
  const queue = pendingErrorQueues.get(runId)
  if (!queue || queue.length === 0) {
    pendingErrorQueues.delete(runId)
    return null
  }
  return queue.shift() || null
}

export function hasPendingErrors(runId: string): boolean {
  const queue = pendingErrorQueues.get(runId)
  return !!queue && queue.length > 0
}

export function clearPendingErrorQueue(runId: string): void {
  pendingErrorQueues.delete(runId)
}

/**
 * After the AI reads the file, build specific instructions telling it
 * exactly which line to remove using edit_file search/replace.
 * Returns the instruction string to inject into the AI's context.
 */
export function buildFixInstructions(ctx: ErrorContext, fileContent: string): string {
  const lines = fileContent.split("\n")
  const fileName = ctx.targetImport.split("/").pop() || ctx.targetImport

  // Find the offending import line
  let matchedLine: string | null = null
  let matchedLineNum = -1

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    if (!trimmed.startsWith("import") && !trimmed.includes("require(")) continue

    // Check if this line contains the import target (by filename or full path)
    if (trimmed.includes(ctx.targetImport) || trimmed.includes(fileName)) {
      matchedLine = lines[i]
      matchedLineNum = i + 1
      break
    }
  }

  let instructions = `\n[ERROR-FIX INSTRUCTIONS]\n`
  instructions += `The user reported: import "${ctx.targetImport}" failed to resolve from "${ctx.sourceFile}".\n`

  if (matchedLine) {
    instructions += `\nFOUND the bad import at line ${matchedLineNum}:\n`
    instructions += `  ${matchedLine.trim()}\n`
    instructions += `\nFIX: Use edit_file with search/replace to remove this EXACT line:\n`
    instructions += `  tool: "edit_file"\n`
    instructions += `  args: { "path": "${ctx.sourceFile}", "search": ${JSON.stringify(matchedLine + "\n")}, "replace": "" }\n`
    instructions += `\nDo NOT rewrite the entire file. Do NOT create new files. Just remove that one import line.`
  } else {
    instructions += `\nCould NOT find an import line containing "${fileName}" in the file.\n`
    instructions += `The file might have already been fixed, or the import uses unusual syntax.\n`
    instructions += `Look at the file content above and find any import/require that references "${ctx.targetImport}" or "${fileName}".\n`
    instructions += `If found, use edit_file search/replace to remove it. If not found, tell the user the import was already removed.`
  }

  instructions += `\n[END ERROR-FIX INSTRUCTIONS]`
  return instructions
}

// ─── Pending error context management ───

export function setPendingError(runId: string, ctx: ErrorContext): void {
  pendingErrors.set(runId, ctx)
}

export function getPendingError(runId: string): ErrorContext | null {
  return pendingErrors.get(runId) || null
}

export function clearPendingError(runId: string): void {
  pendingErrors.delete(runId)
}

// ─── Pending file content for programmatic fix ───

const pendingFileContents = new Map<string, string>()

export function setPendingFileContent(runId: string, content: string): void {
  pendingFileContents.set(runId, content)
}

export function getPendingFileContent(runId: string): string | null {
  return pendingFileContents.get(runId) || null
}

export function clearPendingFileContent(runId: string): void {
  pendingFileContents.delete(runId)
}

/**
 * Build a programmatic edit_file action to fix a known error.
 * Used as a last resort when the AI repeatedly fails to produce valid edit args.
 * Returns null if the fix cannot be determined.
 */
export function buildProgrammaticFix(ctx: ErrorContext, fileContent: string): NormalizedResponse | null {
  const lines = fileContent.split("\n")
  const fileName = ctx.targetImport.split("/").pop() || ctx.targetImport

  let matchedLine: string | null = null

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    if (!trimmed.startsWith("import") && !trimmed.includes("require(")) continue
    if (trimmed.includes(ctx.targetImport) || trimmed.includes(fileName)) {
      matchedLine = lines[i]
      break
    }
  }

  if (!matchedLine) return null

  console.log(`[error-autofix] Building programmatic fix: removing "${matchedLine.trim()}" from "${ctx.sourceFile}"`)

  return {
    kind: "needs_tool",
    tool: "edit_file",
    args: {
      path: ctx.sourceFile,
      search: matchedLine + "\n",
      replace: ""
    },
    content: `Removing broken import "${ctx.targetImport}" from ${ctx.sourceFile} (programmatic fix).`,
    reasoning: `Programmatic fix: the AI failed to produce valid edit_file args, so the system is executing the fix directly.`,
    usage: { inputTokens: 0, outputTokens: 0 }
  }
}
