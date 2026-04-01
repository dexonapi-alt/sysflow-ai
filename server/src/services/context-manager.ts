/**
 * ContextManager — Smart context awareness for each AI run.
 *
 * Problems this solves:
 * 1. Tool results grow unbounded (full file contents dumped back as context)
 * 2. Session history is a massive uncompressed dump
 * 3. Context entries accumulate without deduplication or expiry
 * 4. AI treats all context as equally reliable (no staleness tracking)
 * 5. No relevance filtering — everything gets injected
 *
 * Design:
 * - Per-run WorkingContext: small, curated set of verified facts
 * - Tool results compressed to summaries (path + outcome, not raw content)
 * - File knowledge tracked as "verified this run" vs "stale from history"
 * - Context budget enforced — stays under a token limit
 * - Deduplication: same file/path/concept → keep only latest
 */

// ─── Types ───

interface FileKnowledge {
  path: string
  /** What happened: "created", "read", "edited", "deleted", "errored" */
  action: "created" | "read" | "edited" | "deleted" | "errored"
  /** Brief summary — NOT the full content */
  summary: string
  /** When this knowledge was obtained (tool call index) */
  tick: number
  /** Whether this was verified in the current run */
  verified: boolean
}

interface FactEntry {
  key: string
  value: string
  source: "tool_result" | "session_history" | "context_db" | "directory_tree"
  tick: number
  verified: boolean
}

interface WorkingContext {
  /** Files the AI knows about — keyed by path, only latest state kept */
  files: Map<string, FileKnowledge>
  /** Key facts — keyed by unique key, deduped */
  facts: Map<string, FactEntry>
  /** Errors encountered this run — kept for debugging context */
  errors: Array<{ tool: string; message: string; tick: number }>
  /** Commands run this run — brief summaries */
  commands: Array<{ command: string; outcome: string; tick: number }>
  /** User decisions from previous sessions */
  userDecisions: string[]
  /** Monotonic counter for ordering */
  tick: number
  /** Original task prompt */
  originalTask: string
}

// ─── Singleton Manager ───

const runContexts = new Map<string, WorkingContext>()

/** Maximum context entries before we start pruning oldest unverified */
const MAX_FILE_ENTRIES = 80
const MAX_FACT_ENTRIES = 30
const MAX_ERROR_ENTRIES = 10
const MAX_COMMAND_ENTRIES = 15

// ─── Public API ───

export function initRunContext(runId: string, originalTask: string): void {
  runContexts.set(runId, {
    files: new Map(),
    facts: new Map(),
    errors: [],
    commands: [],
    userDecisions: [],
    tick: 0,
    originalTask
  })
}

export function clearRunContext(runId: string): void {
  runContexts.delete(runId)
}

/**
 * Ingest session history into the working context.
 * Instead of dumping 20 raw sessions, we extract:
 * - File states (created/modified — marked as UNVERIFIED)
 * - User decisions
 * - Last error
 * - Key commands that succeeded
 */
export function ingestSessionHistory(
  runId: string,
  sessions: Array<{
    prompt: string
    outcome: string
    error: string | null
    filesModified: string[]
    actions: Array<{ tool: string; path?: string; command?: string; output?: string; answer?: string }>
  }>
): void {
  const ctx = runContexts.get(runId)
  if (!ctx) return

  for (const session of sessions) {
    // Track files from previous sessions as UNVERIFIED
    for (const filePath of session.filesModified) {
      if (!ctx.files.has(filePath)) {
        ctx.files.set(filePath, {
          path: filePath,
          action: "created",
          summary: `Created in previous session (${session.outcome})`,
          tick: 0,
          verified: false  // NOT verified — may have been deleted since
        })
      }
    }

    // Extract user decisions
    for (const action of session.actions) {
      if (action.tool === "_user_response" && action.answer) {
        if (!ctx.userDecisions.includes(action.answer)) {
          ctx.userDecisions.push(action.answer)
        }
      }
    }

    // Track last error as a fact
    if (session.error && session.outcome === "failed") {
      ctx.facts.set("last_session_error", {
        key: "last_session_error",
        value: session.error.slice(0, 200),
        source: "session_history",
        tick: 0,
        verified: false
      })
    }
  }
}

/**
 * Ingest directory tree into working context.
 * This is VERIFIED truth — the directory was just scanned.
 */
export function ingestDirectoryTree(
  runId: string,
  tree: Array<{ name: string; type: string }>
): void {
  const ctx = runContexts.get(runId)
  if (!ctx) return

  ctx.facts.set("project_structure", {
    key: "project_structure",
    value: tree
      .filter((e) => !e.name.startsWith("sysbase"))
      .map((e) => `${e.type === "directory" ? "[dir]" : "[file]"} ${e.name}`)
      .join(", "),
    source: "directory_tree",
    tick: ctx.tick,
    verified: true
  })
}

/**
 * Ingest a tool result into working context.
 * Compresses the result — keeps outcome, discards raw content.
 */
export function ingestToolResult(
  runId: string,
  tool: string,
  args: Record<string, unknown>,
  result: Record<string, unknown>
): void {
  const ctx = runContexts.get(runId)
  if (!ctx) return

  ctx.tick++
  const tick = ctx.tick
  const success = result.success !== false && !result.error

  // ─── File operations: track file state ───
  if (tool === "write_file" && args.path) {
    const p = args.path as string
    ctx.files.set(p, {
      path: p,
      action: "created",
      summary: success ? `Created (${estimateSize(args.content as string)})` : `Failed: ${(result.error as string || "").slice(0, 100)}`,
      tick,
      verified: true
    })
  }

  if (tool === "edit_file" && args.path) {
    const p = args.path as string
    ctx.files.set(p, {
      path: p,
      action: "edited",
      summary: success ? "Edited successfully" : `Edit failed: ${(result.error as string || "").slice(0, 100)}`,
      tick,
      verified: true
    })
  }

  if (tool === "read_file" && args.path) {
    const p = args.path as string
    const content = result.content as string | undefined
    ctx.files.set(p, {
      path: p,
      action: "read",
      summary: success && content
        ? `Read (${estimateSize(content)}): ${extractFileSummary(content)}`
        : `Read failed: ${(result.error as string || "").slice(0, 100)}`,
      tick,
      verified: true
    })
  }

  if (tool === "batch_read" && Array.isArray(result.files)) {
    for (const file of result.files as Array<{ path: string; content?: string; error?: string; success: boolean }>) {
      ctx.files.set(file.path, {
        path: file.path,
        action: "read",
        summary: file.success && file.content
          ? `Read (${estimateSize(file.content)}): ${extractFileSummary(file.content)}`
          : `Read failed: ${(file.error || "").slice(0, 100)}`,
        tick,
        verified: true
      })
    }
  }

  if (tool === "delete_file" && args.path) {
    const p = args.path as string
    ctx.files.set(p, {
      path: p,
      action: "deleted",
      summary: success ? "Deleted" : `Delete failed: ${(result.error as string || "").slice(0, 100)}`,
      tick,
      verified: true
    })
  }

  if (tool === "batch_write" && Array.isArray(result.files)) {
    for (const file of result.files as Array<{ path: string; success: boolean; error?: string }>) {
      ctx.files.set(file.path, {
        path: file.path,
        action: "created",
        summary: file.success ? "Created (batch)" : `Failed: ${(file.error || "").slice(0, 100)}`,
        tick,
        verified: true
      })
    }
  }

  if (tool === "create_directory" && args.path) {
    ctx.facts.set(`dir:${args.path}`, {
      key: `dir:${args.path}`,
      value: success ? "Created" : `Failed: ${(result.error as string || "").slice(0, 80)}`,
      source: "tool_result",
      tick,
      verified: true
    })
  }

  if (tool === "list_directory") {
    const entries = result.entries as string[] | undefined
    if (entries) {
      ctx.facts.set(`ls:${args.path || "."}`, {
        key: `ls:${args.path || "."}`,
        value: entries.slice(0, 30).join(", ") + (entries.length > 30 ? ` ... (${entries.length} total)` : ""),
        source: "tool_result",
        tick,
        verified: true
      })
    }
  }

  if (tool === "file_exists" && args.path) {
    ctx.facts.set(`exists:${args.path}`, {
      key: `exists:${args.path}`,
      value: result.exists ? "yes" : "no",
      source: "tool_result",
      tick,
      verified: true
    })
  }

  // ─── Commands ───
  if (tool === "run_command") {
    const cmd = (args.command as string || "").slice(0, 120)
    const outcome = success
      ? (result.skipped ? "skipped" : "success")
      : `error: ${(result.error as string || result.stderr as string || "").slice(0, 120)}`
    ctx.commands.push({ command: cmd, outcome, tick })

    // Prune old commands
    if (ctx.commands.length > MAX_COMMAND_ENTRIES) {
      ctx.commands = ctx.commands.slice(-MAX_COMMAND_ENTRIES)
    }
  }

  // ─── Search results: store as facts ───
  if (tool === "search_code" || tool === "search_files") {
    const matches = result.matches || result.results
    if (Array.isArray(matches)) {
      ctx.facts.set(`search:${args.pattern || args.query || "?"}`, {
        key: `search:${args.pattern || args.query || "?"}`,
        value: `Found ${matches.length} results`,
        source: "tool_result",
        tick,
        verified: true
      })
    }
  }

  // ─── Errors ───
  if (!success && result.error) {
    ctx.errors.push({
      tool,
      message: (result.error as string).slice(0, 200),
      tick
    })
    if (ctx.errors.length > MAX_ERROR_ENTRIES) {
      ctx.errors = ctx.errors.slice(-MAX_ERROR_ENTRIES)
    }
  }

  // ─── Pruning ───
  pruneIfNeeded(ctx)
}

/**
 * Ingest context entries from the database.
 * Marks them as unverified (they may be outdated).
 */
export function ingestContextEntries(
  runId: string,
  entries: Array<{ category: string; title: string; content: string; created_at: string }>
): void {
  const ctx = runContexts.get(runId)
  if (!ctx) return

  for (const entry of entries) {
    const key = `ctx:${entry.category}:${entry.title.slice(0, 60)}`
    // Only keep if we don't already have a more recent fact with the same key
    if (!ctx.facts.has(key)) {
      ctx.facts.set(key, {
        key,
        value: entry.content.slice(0, 200),
        source: "context_db",
        tick: 0,
        verified: false
      })
    }
  }

  pruneIfNeeded(ctx)
}

/**
 * Build the compressed context string for injection into model messages.
 * This is what replaces the raw session dump / tool result dump.
 */
export function buildWorkingContextString(runId: string): string | null {
  const ctx = runContexts.get(runId)
  if (!ctx) return null

  const sections: string[] = []

  // ─── File knowledge (verified vs stale) ───
  const verifiedFiles = [...ctx.files.values()].filter((f) => f.verified)
  const staleFiles = [...ctx.files.values()].filter((f) => !f.verified)

  if (verifiedFiles.length > 0) {
    const fileLines = verifiedFiles
      .sort((a, b) => a.tick - b.tick)
      .map((f) => `  ${f.action === "deleted" ? "✗" : "✓"} ${f.path} — ${f.summary}`)
    sections.push(`FILES KNOWN (verified this run):\n${fileLines.join("\n")}`)
  }

  if (staleFiles.length > 0) {
    const staleLines = staleFiles
      .map((f) => `  ? ${f.path} — ${f.summary}`)
      .slice(0, 20)
    sections.push(`FILES FROM HISTORY (unverified — may not exist):\n${staleLines.join("\n")}`)
  }

  // ─── User decisions ───
  if (ctx.userDecisions.length > 0) {
    sections.push(`USER DECISIONS (confirmed — do NOT re-ask):\n${ctx.userDecisions.map((d) => `  - "${d}"`).join("\n")}`)
  }

  // ─── Commands run ───
  if (ctx.commands.length > 0) {
    const cmdLines = ctx.commands
      .slice(-10)
      .map((c) => `  ${c.outcome === "success" ? "✓" : c.outcome === "skipped" ? "⊘" : "✗"} ${c.command} → ${c.outcome}`)
    sections.push(`COMMANDS RUN:\n${cmdLines.join("\n")}`)
  }

  // ─── Errors ───
  if (ctx.errors.length > 0) {
    const errLines = ctx.errors
      .slice(-5)
      .map((e) => `  ✗ ${e.tool}: ${e.message}`)
    sections.push(`RECENT ERRORS:\n${errLines.join("\n")}`)
  }

  // ─── Learned context (from DB, unverified) ───
  const dbFacts = [...ctx.facts.values()].filter((f) => f.source === "context_db")
  if (dbFacts.length > 0) {
    const factLines = dbFacts
      .slice(0, 10)
      .map((f) => `  ${f.verified ? "✓" : "?"} ${f.key.replace("ctx:", "")}: ${f.value.slice(0, 150)}`)
    sections.push(`LEARNED PATTERNS (from previous runs — may be outdated):\n${factLines.join("\n")}`)
  }

  if (sections.length === 0) return null

  return `═══ WORKING CONTEXT (managed — verified facts only) ═══\n${sections.join("\n\n")}\n═══ END WORKING CONTEXT ═══`
}

/**
 * Build a compressed session summary for the initial model call.
 * Replaces the raw 20-session dump.
 */
export function buildCompressedSessionSummary(
  runId: string,
  sessions: Array<{
    prompt: string
    outcome: string
    error: string | null
    filesModified: string[]
    actions: Array<{ tool: string; path?: string; command?: string }>
  }>
): string | null {
  if (sessions.length === 0) return null

  const ctx = runContexts.get(runId)

  // Ingest into working context
  if (ctx) {
    ingestSessionHistory(runId, sessions as Parameters<typeof ingestSessionHistory>[1])
  }

  // Build a compressed summary — not a raw dump
  const completed = sessions.filter((s) => s.outcome === "completed")
  const failed = sessions.filter((s) => s.outcome === "failed")
  const interrupted = sessions.filter((s) => s.outcome === "interrupted")

  const lines: string[] = []
  lines.push(`Previous sessions: ${completed.length} completed, ${failed.length} failed, ${interrupted.length} interrupted`)

  // Only show the last 5 sessions, compressed to one line each
  const recent = sessions.slice(-5)
  for (const s of recent) {
    const tag = s.outcome === "completed" ? "✓" : s.outcome === "failed" ? "✗" : "⚡"
    const filesNote = s.filesModified.length > 0 ? ` [${s.filesModified.length} files]` : ""
    const errNote = s.error ? ` err: ${s.error.slice(0, 80)}` : ""
    lines.push(`  ${tag} "${s.prompt.slice(0, 100)}"${filesNote}${errNote}`)
  }

  // All files that exist from previous work (unverified)
  const allFiles = new Set<string>()
  for (const s of sessions) {
    for (const f of s.filesModified) allFiles.add(f)
  }
  if (allFiles.size > 0) {
    const fileList = [...allFiles].slice(0, 30).join(", ")
    lines.push(`\nFiles from previous sessions (UNVERIFIED — may have been deleted):\n  ${fileList}`)
    if (allFiles.size > 30) lines.push(`  ... and ${allFiles.size - 30} more`)
  }

  // User decisions
  const userDecisions: string[] = []
  for (const s of sessions) {
    for (const a of s.actions) {
      if (a.tool === "_user_response" && (a as Record<string, unknown>).answer) {
        const answer = String((a as Record<string, unknown>).answer)
        if (!userDecisions.includes(answer)) userDecisions.push(answer)
      }
    }
  }
  if (userDecisions.length > 0) {
    lines.push(`\nUser decisions (do NOT re-ask): ${userDecisions.map((d) => `"${d}"`).join(", ")}`)
  }

  // Last error
  const lastFailed = [...sessions].reverse().find((s) => s.error)
  if (lastFailed?.error) {
    lines.push(`\nLast error: ${lastFailed.error.slice(0, 200)}`)
  }

  return lines.join("\n")
}

/**
 * Get the working context for inspection (used by handlers).
 */
export function getRunContext(runId: string): WorkingContext | undefined {
  return runContexts.get(runId)
}

/**
 * Check if a file is known and verified in the current run.
 * Useful for "read-before-edit" — if we already read it this run, no need to re-read.
 */
export function isFileVerified(runId: string, filePath: string): boolean {
  const ctx = runContexts.get(runId)
  if (!ctx) return false
  const entry = ctx.files.get(filePath)
  return entry?.verified === true
}

/**
 * Get list of files created in this run (verified).
 */
export function getVerifiedFiles(runId: string): string[] {
  const ctx = runContexts.get(runId)
  if (!ctx) return []
  return [...ctx.files.entries()]
    .filter(([, f]) => f.verified && (f.action === "created" || f.action === "edited"))
    .map(([path]) => path)
}

// ─── Internal Helpers ───

function pruneIfNeeded(ctx: WorkingContext): void {
  // Prune files: keep verified, drop oldest unverified
  if (ctx.files.size > MAX_FILE_ENTRIES) {
    const entries = [...ctx.files.entries()]
      .sort((a, b) => {
        // Verified entries are kept over unverified
        if (a[1].verified !== b[1].verified) return a[1].verified ? -1 : 1
        // Among same verification status, keep newer
        return b[1].tick - a[1].tick
      })
    ctx.files = new Map(entries.slice(0, MAX_FILE_ENTRIES))
  }

  // Prune facts: keep verified and tool_result source, drop oldest context_db
  if (ctx.facts.size > MAX_FACT_ENTRIES) {
    const entries = [...ctx.facts.entries()]
      .sort((a, b) => {
        if (a[1].verified !== b[1].verified) return a[1].verified ? -1 : 1
        if (a[1].source !== b[1].source) {
          const priority: Record<string, number> = { tool_result: 0, directory_tree: 1, session_history: 2, context_db: 3 }
          return (priority[a[1].source] || 3) - (priority[b[1].source] || 3)
        }
        return b[1].tick - a[1].tick
      })
    ctx.facts = new Map(entries.slice(0, MAX_FACT_ENTRIES))
  }
}

function estimateSize(content: string | undefined): string {
  if (!content) return "empty"
  const lines = content.split("\n").length
  if (lines <= 1) return `${content.length} chars`
  return `${lines} lines`
}

function extractFileSummary(content: string): string {
  if (!content) return "(empty)"
  const lines = content.split("\n")

  // Look for key indicators
  const indicators: string[] = []

  // Imports
  const imports = lines.filter((l) => l.match(/^import |^const .* = require|^from /)).length
  if (imports > 0) indicators.push(`${imports} imports`)

  // Exports
  const exports = lines.filter((l) => l.match(/^export /)).length
  if (exports > 0) indicators.push(`${exports} exports`)

  // Functions/classes
  const funcs = lines.filter((l) => l.match(/function |=> |class |def |fn /)).length
  if (funcs > 0) indicators.push(`${funcs} funcs`)

  if (indicators.length > 0) {
    return indicators.join(", ")
  }

  // Fallback: first meaningful line
  const firstLine = lines.find((l) => l.trim().length > 5)
  return firstLine ? firstLine.trim().slice(0, 60) : "(empty)"
}
