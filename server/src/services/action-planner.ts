/**
 * Action Planner — intelligent orchestration layer between AI model and tool execution.
 *
 * This is a PROGRAMMATIC SYSTEM, not a prompt hack. It:
 * 1. Intercepts every AI tool call before it reaches the client
 * 2. Detects broken args, loops, oscillations, and stuck states
 * 3. Transforms broken calls into working multi-step sequences
 * 4. Enforces read-before-edit automatically
 * 5. Tracks tool results to learn what works and what doesn't
 * 6. Auto-escalates (edit → write) after repeated failures
 * 7. Caches file existence to prevent blind reads
 * 8. Provides rich context injection for the AI's next turn
 */

import type { NormalizedResponse, ToolCall } from "../types.js"
import { detectConfigFile, hasSearchedForFramework, buildConfigSearchOverride, checkToolsForConfigFiles, markFrameworkSearched, clearRunSearches } from "./setup-intelligence.js"
import { isBannedCommand, validateImports } from "./scaffold-validator.js"
import { getPendingError, getPendingFileContent, clearPendingFileContent, buildProgrammaticFix } from "./error-autofix.js"

// ─── Types ───

interface Intent {
  tool: string
  path?: string
  operation: "read" | "write" | "edit" | "delete" | "command" | "search" | "navigate" | "other"
  timestamp: number
  success?: boolean  // filled in by recordResult
}

interface ToolFailure {
  tool: string
  path: string
  error: string
  timestamp: number
}

interface PlannerState {
  runId: string

  // Intent & action tracking
  intents: Intent[]
  actionSignatures: string[]           // "edit_file:src/app.ts" history (last 20)
  consecutiveFailures: Map<string, number>

  // Context injection
  pendingContext: string | null

  // Interception tracking
  interceptionCount: number
  maxInterceptionsPerFile: Map<string, number>

  // ─── Smart awareness ───

  // File state cache: track which files we KNOW exist or don't
  fileExists: Map<string, boolean>     // path → exists
  fileReadContent: Map<string, boolean> // path → has been read this run (AI has context)
  fileReadOrder: string[]               // ordered list of read file paths (most recent last)

  // Forced reconnaissance: has ANY read/list/search been performed this run?
  hasPerformedAnyRead: boolean

  // Does this run have an existing project (not empty dir)?
  hasExistingProject: boolean | null   // null = not yet determined

  // Error pattern tracking
  toolFailures: ToolFailure[]          // recent failures
  bannedEdits: Set<string>             // paths where edit_file is permanently banned → use write_file

  // Oscillation detection
  lastNActions: string[]               // last 10 action signatures for pattern matching

  // Stashed scaffold command — survives context consumption
  stashedScaffoldCommand: string | null
  scaffoldCommandExecuted: boolean

  // Scaffold tracking: detect when scaffolding is abandoned
  scaffoldDirectory: string | null     // directory created by scaffold (e.g., "a", "my-app")
  scaffoldAbandoned: boolean           // true when AI writes files outside scaffold dir

  // Global broken-args counter: if model consistently can't produce content, terminate
  globalBrokenWriteCount: number

  // Pending scaffold directory listing — force AI to see scaffold output
  pendingScaffoldList: string | null

  // Fatal termination flag — when true, bypass all guards and allow completion
  fatalTermination: boolean
}

// ─── Path extraction utility ───

const PATH_PATTERNS = [
  /(?:read|edit|write|update|modify|fix|create|delete|check|open)\s+[`'"]*([a-zA-Z0-9_./\\-]+\.[a-zA-Z]{1,6})[`'"]*(?:\s|$|,|\.)/gi,
  /`([a-zA-Z0-9_./\\-]+\.[a-zA-Z]{1,6})`/g,
  /(?:^|\s|['"`])((?:src|app|frontend|backend|pages|components|lib|utils|public|prisma)[a-zA-Z0-9_./\\-]+\.[a-zA-Z]{1,6})(?:\s|$|['"`]|,|\.)/gi,
]

export function extractPathsFromText(text: string): string[] {
  const paths: string[] = []
  for (const pattern of PATH_PATTERNS) {
    pattern.lastIndex = 0
    let match
    while ((match = pattern.exec(text)) !== null) {
      const p = match[1]
      if (p && !paths.includes(p) && p.length > 3 && p.includes("/")) {
        paths.push(p)
      }
    }
  }
  return paths
}

// ─── Scaffold directory extraction ───

const SCAFFOLD_CMD_PATTERNS = [
  /create-vite[@\w.]*\s+(\S+)/,
  /create-next-app[@\w.]*\s+(\S+)/,
  /create-react-app[@\w.]*\s+(\S+)/,
  /create-remix[@\w.]*\s+(\S+)/,
  /create-astro[@\w.]*\s+(\S+)/,
  /@nestjs\/cli\s+new\s+(\S+)/,
  /@angular\/cli\s+new\s+(\S+)/,
  /nuxi[@\w.]*\s+init\s+(\S+)/,
  /django-admin\s+startproject\s+(\S+)/,
  /composer\s+create-project\s+\S+\s+(\S+)/,
]

function extractScaffoldDir(command: string): string | null {
  for (const pattern of SCAFFOLD_CMD_PATTERNS) {
    const match = command.match(pattern)
    if (match && match[1] && match[1] !== "." && match[1] !== "--") {
      // Clean up flags that might be captured
      const dir = match[1].replace(/^--.*/, "").replace(/^-.*/, "")
      if (dir && dir.length > 0 && !dir.startsWith("-")) return dir
    }
  }
  return null
}

// ─── Tool classification ───

const TOOLS_NEEDING_PATH = new Set(["read_file", "write_file", "edit_file", "create_directory", "delete_file", "move_file", "file_exists"])
const TOOLS_NEEDING_CONTENT = new Set(["write_file"])

function classifyOperation(tool: string): Intent["operation"] {
  if (tool === "read_file" || tool === "batch_read") return "read"
  if (tool === "write_file" || tool === "batch_write") return "write"
  if (tool === "edit_file") return "edit"
  if (tool === "delete_file") return "delete"
  if (tool === "run_command") return "command"
  if (tool === "search_code" || tool === "search_files" || tool === "web_search") return "search"
  if (tool === "list_directory") return "navigate"
  return "other"
}

function getActionSignature(tool: string, args?: Record<string, unknown>): string {
  const path = args?.path as string || "no-path"
  return `${tool}:${path}`
}

function hasValidArgs(tool: string, args?: Record<string, unknown>): boolean {
  if (!args) return false
  if (TOOLS_NEEDING_PATH.has(tool) && !args.path) return false
  if (TOOLS_NEEDING_CONTENT.has(tool) && !args.content) return false
  // edit_file: valid if it has search, line_start, insert_at, patch, OR content
  if (tool === "edit_file") {
    const hasSearchReplace = args.search !== undefined && args.search !== null
    const hasLineEdit = args.line_start !== undefined && args.line_start !== null
    const hasInsert = args.insert_at !== undefined && args.insert_at !== null
    const hasPatch = !!args.patch
    const hasContent = !!args.content
    if (!hasSearchReplace && !hasLineEdit && !hasInsert && !hasPatch && !hasContent) return false
  }
  return true
}

/** Check if an edit_file uses the new targeted modes (search/replace, line edit, insert) */
function isTargetedEdit(args?: Record<string, unknown>): boolean {
  if (!args) return false
  return (args.search !== undefined && args.search !== null) ||
         (args.line_start !== undefined && args.line_start !== null) ||
         (args.insert_at !== undefined && args.insert_at !== null)
}

// ─── Action Planner ───

class ActionPlanner {
  private state = new Map<string, PlannerState>()

  private getState(runId: string): PlannerState {
    if (!this.state.has(runId)) {
      this.state.set(runId, {
        runId,
        intents: [],
        actionSignatures: [],
        consecutiveFailures: new Map(),
        pendingContext: null,
        interceptionCount: 0,
        maxInterceptionsPerFile: new Map(),
        fileExists: new Map(),
        fileReadContent: new Map(),
        fileReadOrder: [],
        hasPerformedAnyRead: false,
        hasExistingProject: null,
        toolFailures: [],
        bannedEdits: new Set(),
        lastNActions: [],
        stashedScaffoldCommand: null,
        scaffoldCommandExecuted: false,
        scaffoldDirectory: null,
        scaffoldAbandoned: false,
        globalBrokenWriteCount: 0,
        pendingScaffoldList: null,
        fatalTermination: false
      })
    }
    return this.state.get(runId)!
  }

  // ═══ PUBLIC API ═══

  /**
   * Intercept an AI response before it reaches the client.
   * Fixes broken tool calls, enforces read-before-edit, detects loops.
   */
  intercept(runId: string, normalized: NormalizedResponse): NormalizedResponse {
    if (normalized.kind !== "needs_tool") return normalized

    const state = this.getState(runId)

    // Record intent
    state.intents.push({
      tool: normalized.tool || "unknown",
      path: normalized.args?.path as string | undefined,
      operation: classifyOperation(normalized.tool || ""),
      timestamp: Date.now()
    })

    // Handle parallel tools
    if (normalized.tools && normalized.tools.length > 0) {
      return this.interceptParallel(state, normalized)
    }

    // Handle single tool
    return this.interceptSingle(state, normalized)
  }

  /**
   * Record a tool execution result — updates file cache and failure tracking.
   * Called BEFORE sending results to the AI for the next turn.
   */
  recordResult(runId: string, tool: string, result: Record<string, unknown>): void {
    const state = this.state.get(runId)
    if (!state) return

    const path = result.path as string | undefined
    const success = result.success !== false && !result.error

    // Mark read/list/search as reconnaissance completed
    if (success && ["read_file", "batch_read", "list_directory", "search_code", "search_files"].includes(tool)) {
      state.hasPerformedAnyRead = true

      // After listing the scaffold directory, queue reads of key files so AI knows the structure
      if (tool === "list_directory" && state.scaffoldDirectory && state.scaffoldCommandExecuted) {
        const dir = state.scaffoldDirectory
        const entries = result.entries as Array<{ name: string; type: string }> | undefined
        if (entries) {
          // Find key files to read
          const hasPackageJson = entries.some(e => e.name === "package.json")
          const hasSrc = entries.some(e => e.name === "src" && e.type === "directory")
          if (hasPackageJson) {
            // Inject context telling AI to read scaffold files
            state.pendingContext = (state.pendingContext || "") +
              `\n[PLANNER] Scaffold directory "${dir}" contains: ${entries.map(e => e.name).join(", ")}. ` +
              `Read "${dir}/package.json" first, then check "${dir}/src/" for the entry file. ` +
              `Write ALL your source files inside "${dir}/src/". Paths must be like "${dir}/src/components/Hero.tsx".`
          }
        }
      }
    }

    // Mark scaffold command as executed after first successful run_command
    if (tool === "run_command" && success && state.stashedScaffoldCommand) {
      state.scaffoldCommandExecuted = true
      // Extract the scaffold directory from the command (e.g., "create-vite a" → "a")
      const scaffoldDir = extractScaffoldDir(state.stashedScaffoldCommand)
      if (scaffoldDir) {
        state.scaffoldDirectory = scaffoldDir
        state.pendingScaffoldList = scaffoldDir  // Force a directory listing on next intercept
        console.log(`[planner] Scaffold command executed → scaffold directory: "${scaffoldDir}" — will force directory listing`)
      } else {
        console.log(`[planner] Scaffold command executed — clearing stash to prevent re-use`)
      }
    }

    // Detect scaffold abandonment: AI writes files OUTSIDE the scaffold directory
    if ((tool === "write_file" || tool === "edit_file") && success && path && state.scaffoldDirectory && !state.scaffoldAbandoned) {
      const normalizedPath = path.replace(/\\/g, "/")
      if (!normalizedPath.startsWith(state.scaffoldDirectory + "/") && !normalizedPath.startsWith(state.scaffoldDirectory + "\\")) {
        state.scaffoldAbandoned = true
        console.log(`[planner] Scaffold ABANDONED: AI wrote "${path}" outside scaffold dir "${state.scaffoldDirectory}/"`)
      }
    }

    // Track web searches — mark frameworks as searched so config files aren't re-searched
    if (tool === "web_search" && success) {
      const query = ((result.query as string) || "").toLowerCase()
      if (query.includes("tailwind") || query.includes("postcss")) markFrameworkSearched(runId, "postcss"), markFrameworkSearched(runId, "tailwind")
      if (query.includes("vite")) markFrameworkSearched(runId, "vite")
      if (query.includes("next")) markFrameworkSearched(runId, "nextjs")
      if (query.includes("eslint")) markFrameworkSearched(runId, "eslint")
      if (query.includes("prisma")) markFrameworkSearched(runId, "prisma")
      if (query.includes("typescript") || query.includes("tsconfig")) markFrameworkSearched(runId, "typescript")
    }

    // Reset global broken-write counter on any successful write
    if ((tool === "write_file" || tool === "edit_file") && success) {
      state.globalBrokenWriteCount = 0
    }

    // Update file existence cache
    if (path) {
      if (tool === "write_file" || tool === "edit_file" || tool === "create_directory") {
        if (success) state.fileExists.set(path, true)
      }
      if (tool === "read_file" && success) {
        state.fileExists.set(path, true)
        state.fileReadContent.set(path, true)
        state.fileReadOrder.push(path)
      }
      if (tool === "read_file" && !success) {
        const errorStr = String(result.error || "")
        if (errorStr.includes("ENOENT") || errorStr.includes("no such file")) {
          state.fileExists.set(path, false)
        }
      }
      if (tool === "delete_file" && success) {
        state.fileExists.set(path, false)
        state.fileReadContent.delete(path)
      }
    }

    // Track failures
    if (!success && path) {
      state.toolFailures.push({
        tool,
        path,
        error: String(result.error || "unknown").slice(0, 200),
        timestamp: Date.now()
      })

      // Auto-ban edit_file for a path after 2 failures → force write_file
      if (tool === "edit_file") {
        const editFails = state.toolFailures.filter((f) => f.tool === "edit_file" && f.path === path).length
        if (editFails >= 2) {
          state.bannedEdits.add(path)
          console.log(`[planner] Banned edit_file for "${path}" after ${editFails} failures — will use write_file`)
        }
      }
    }

    // Update last intent with success status
    if (state.intents.length > 0) {
      state.intents[state.intents.length - 1].success = success
    }
  }

  /**
   * Record results from a batch of tool executions.
   */
  recordBatchResults(runId: string, results: Array<{ tool: string; result: Record<string, unknown> }>): void {
    for (const r of results) {
      this.recordResult(runId, r.tool, r.result)
    }
  }

  /**
   * Get context to inject into the next tool result message.
   */
  getPendingContext(runId: string): string | null {
    const state = this.state.get(runId)
    if (!state || !state.pendingContext) return null
    const ctx = state.pendingContext
    state.pendingContext = null
    return ctx
  }

  /**
   * Inject context into the next tool result message for a run.
   * Used to provide the AI with specific instructions (e.g., scaffold command).
   */
  injectContext(runId: string, context: string): void {
    const state = this.getState(runId)
    state.pendingContext = state.pendingContext
      ? state.pendingContext + "\n" + context
      : context

    // Stash scaffold commands so they survive context consumption
    const cmdMatch = context.match(/Run this EXACT command:\s*(.+?)(?:\n|$)/)
    if (cmdMatch) {
      state.stashedScaffoldCommand = cmdMatch[1]
    }
  }

  /**
   * Set whether the run has an existing project (for forced reconnaissance).
   * Called from user-message handler after inspecting directoryTree.
   */
  setHasExistingProject(runId: string, hasProject: boolean): void {
    const state = this.getState(runId)
    state.hasExistingProject = hasProject
  }

  /** Get scaffold state for session tracking */
  getScaffoldState(runId: string): { directory: string | null; abandoned: boolean } {
    const state = this.state.get(runId)
    if (!state) return { directory: null, abandoned: false }
    return { directory: state.scaffoldDirectory, abandoned: state.scaffoldAbandoned }
  }

  /** Check if the run hit a fatal error (bypass all guards) */
  isFatalTermination(runId: string): boolean {
    return this.state.get(runId)?.fatalTermination ?? false
  }

  /** Cleanup on run completion */
  clear(runId: string): void {
    this.state.delete(runId)
    clearRunSearches(runId)
  }

  // ═══ INTERCEPTION RULES ═══

  private interceptSingle(state: PlannerState, normalized: NormalizedResponse): NormalizedResponse {
    const tool = normalized.tool || ""
    let args = normalized.args || {}
    let path = args.path as string | undefined

    // ─── Rule -1: Force directory listing after scaffold command ───
    // After create-vite/create-next-app/etc. creates a project, the AI has no idea what files
    // were generated. Force a list_directory on the scaffold dir so it sees the structure.
    if (state.pendingScaffoldList) {
      const scaffoldDir = state.pendingScaffoldList
      state.pendingScaffoldList = null
      console.log(`[planner] Post-scaffold: forcing list_directory on "${scaffoldDir}" so AI sees generated files`)
      state.pendingContext = (state.pendingContext || "") +
        `\n[PLANNER] The scaffold command created a project in "${scaffoldDir}/". ` +
        `The directory listing below shows what was generated. ` +
        `Now read "${scaffoldDir}/package.json" and "${scaffoldDir}/src/App.tsx" (or similar entry file) to understand the scaffold structure, ` +
        `then write your source files INSIDE "${scaffoldDir}/src/". All file paths must start with "${scaffoldDir}/".`
      return {
        ...normalized,
        tool: "list_directory",
        args: { path: scaffoldDir },
        tools: undefined,
        content: `Listing scaffold directory "${scaffoldDir}" to see generated project structure.`
      }
    }

    // ─── Rule 0: Auto-escalate edit_file → write_file for banned paths ───
    if (tool === "edit_file" && path && state.bannedEdits.has(path)) {
      // If it's a targeted edit (search/replace), allow it even if banned — those are reliable
      if (isTargetedEdit(args)) {
        console.log(`[planner] Allowing targeted edit (search/replace) for previously-banned "${path}"`)
        state.bannedEdits.delete(path) // Clear ban since they're using the better approach
      } else if (args.patch) {
        console.log(`[planner] Auto-escalating edit_file → write_file for banned path "${path}"`)
        normalized.tool = "write_file"
        normalized.args = { path, content: args.patch }
        state.pendingContext = `[PLANNER] edit_file was auto-converted to write_file for "${path}" because previous edits kept failing. TIP: Use edit_file with search/replace for targeted changes.`
        return normalized
      }
      // If no patch (broken args), will be caught by Rule 1
    }

    // ─── Rule 0.5: Config file verification — search for current setup docs before writing ───
    if ((tool === "write_file" || tool === "edit_file") && path) {
      const configInfo = detectConfigFile(path)
      if (configInfo && !hasSearchedForFramework(state.runId, configInfo.framework)) {
        console.log(`[planner] Config file "${path}" detected (${configInfo.framework}) — forcing web_search for current setup`)
        const { override, pendingContext } = buildConfigSearchOverride(state.runId, configInfo, normalized)
        state.pendingContext = pendingContext
        return override
      }
    }

    // ─── Rule 0.75: Forced reconnaissance — block write/edit until AI has read something ───
    if ((tool === "write_file" || tool === "edit_file") && !state.hasPerformedAnyRead && state.hasExistingProject === true) {
      console.log(`[planner] Forcing reconnaissance: AI tried to ${tool} before reading any files in existing project`)
      state.pendingContext = `[PLANNER] You must read existing files before writing. The project already has code — understand it first, then implement.`
      return {
        ...normalized,
        tool: "list_directory",
        args: { path: "." },
        tools: undefined,
        content: "Reading project structure before making changes (enforced by planner)."
      }
    }

    // ─── Rule 0.8: Fix run_command with missing command arg ───
    if (tool === "run_command" && !args.command) {
      const missingCmdKey = "_run_command_no_arg"
      const missingCmdCount = (state.consecutiveFailures.get(missingCmdKey) || 0) + 1
      state.consecutiveFailures.set(missingCmdKey, missingCmdCount)

      // After 3+ attempts, break the loop — don't use stash, force write_file approach
      if (missingCmdCount >= 3) {
        console.log(`[planner] run_command missing "command" arg ${missingCmdCount} times — BREAKING LOOP`)
        state.consecutiveFailures.delete(missingCmdKey)
        // Mark scaffold as abandoned — AI should create files at project root
        if (state.scaffoldDirectory || state.stashedScaffoldCommand) {
          state.scaffoldAbandoned = true
          console.log(`[planner] Scaffold ABANDONED due to run_command loop — AI should work at project root`)
        }
        state.stashedScaffoldCommand = null
        const rootHint = state.scaffoldDirectory
          ? ` Write all files relative to the project ROOT (e.g., "src/App.jsx"), NOT inside "${state.scaffoldDirectory}/".`
          : ""
        state.pendingContext = `[PLANNER] LOOP BROKEN: You sent run_command ${missingCmdCount} times without a "command" argument. STOP using run_command. Create project files directly with write_file instead.${rootHint}`
        return {
          ...normalized,
          tool: "list_directory",
          args: { path: "." },
          tools: undefined,
          content: `Loop broken: run_command failed ${missingCmdCount} times without command arg.`
        }
      }

      // Only use stashed scaffold command ONCE — if it hasn't been executed AND hasn't been auto-filled before
      if (state.stashedScaffoldCommand && !state.scaffoldCommandExecuted && missingCmdCount <= 1) {
        const cmd = state.stashedScaffoldCommand
        console.log(`[planner] Auto-fixing run_command with missing args — using scaffold command (once): "${cmd}"`)
        normalized.args = { ...args, command: cmd, cwd: "." }
        return normalized
      }

      // Check pendingContext for a fresh command injection (also only once)
      if (missingCmdCount <= 1) {
        const ctx = state.pendingContext || ""
        const cmdMatch = ctx.match(/Run this EXACT command:\s*(.+?)(?:\n|$)/)
        if (cmdMatch && !state.scaffoldCommandExecuted) {
          console.log(`[planner] Auto-fixing run_command with missing args — using context command (once): "${cmdMatch[1]}"`)
          normalized.args = { ...args, command: cmdMatch[1], cwd: "." }
          state.stashedScaffoldCommand = cmdMatch[1]
          return normalized
        }
      }

      console.log(`[planner] run_command missing "command" arg (attempt ${missingCmdCount}) — redirecting to list_directory`)
      state.pendingContext = (state.pendingContext || "") + `\n[PLANNER] Your run_command was missing the "command" argument. Use run_command with args: {"command": "your command here", "cwd": "."}`
      return {
        ...normalized,
        tool: "list_directory",
        args: { path: "." },
        tools: undefined,
        content: "run_command missing command argument. Checking project state."
      }
    }

    // ─── Rule 0.85: Banned command blocking ───
    if (tool === "run_command") {
      const command = (args.command as string) || ""
      const banReason = isBannedCommand(command)
      if (banReason) {
        console.log(`[planner] BLOCKED banned command: "${command.slice(0, 80)}" — ${banReason}`)
        state.pendingContext = `[PLANNER] Command BLOCKED: "${command.slice(0, 100)}"\nReason: ${banReason}\nContinue with write_file to create source files instead.`
        return {
          ...normalized,
          tool: "list_directory",
          args: { path: "." },
          tools: undefined,
          content: `Command blocked: ${banReason}`
        }
      }
    }

    // ─── Rule 0.9: Import validation for write_file (warning, not blocking) ───
    if (tool === "write_file" && path && args.content) {
      const content = args.content as string
      const importWarnings = validateImports(path, content, state.fileExists)
      if (importWarnings.length > 0) {
        const existing = state.pendingContext || ""
        state.pendingContext = existing + `\n[PLANNER] Import warnings for "${path}":\n${importWarnings.map((w) => `  - ${w}`).join("\n")}\nVerify these imports are correct before moving on.`
      }
    }

    // ─── Rule 0.95: Hard block for tools with completely missing path ───
    // This prevents "read (unknown)", "edit (unknown)", "mkdir (unknown)" from ever reaching the client
    if (TOOLS_NEEDING_PATH.has(tool) && !path) {
      console.log(`[planner] Rule 0.95: ${tool} has no path. fileReadOrder=[${state.fileReadOrder.join(", ")}], fileReadContent keys=[${[...state.fileReadContent.keys()].join(", ")}]`)
      // Strategy 1: Recover from most recently read file (highest priority for edit_file)
      if ((tool === "edit_file" || tool === "write_file") && state.fileReadOrder.length > 0) {
        const lastRead = state.fileReadOrder[state.fileReadOrder.length - 1]
        console.log(`[planner] Missing path for ${tool} — recovered "${lastRead}" from recent read_file history`)
        normalized.args = { ...args, path: lastRead }
        args = normalized.args  // Update local ref so downstream rules see the fixed args
        path = lastRead
        state.pendingContext = (state.pendingContext || "") + `\n[PLANNER] RECOVERED: Your ${tool} was missing "path". Using "${lastRead}" (the file you last read). ALWAYS include "path" in every tool call.`
        // Continue to downstream rules with the fixed path
      }
      // Strategy 2: Extract path from reasoning text
      else {
        const hintPaths = extractPathsFromText(`${normalized.content || ""} ${normalized.reasoning || ""}`)
        if (hintPaths.length > 0) {
          const recovered = hintPaths[0]
          console.log(`[planner] Missing path for ${tool} — recovered "${recovered}" from reasoning text`)
          normalized.args = { ...args, path: recovered }
          args = normalized.args
          path = recovered
          // Continue to downstream rules with the fixed path
        } else {
          // No path at all — block and redirect, but count to prevent infinite loops
          const noPathKey = `_no_path_block_${tool}`
          const noPathCount = (state.consecutiveFailures.get(noPathKey) || 0) + 1
          state.consecutiveFailures.set(noPathKey, noPathCount)

          if (noPathCount >= 4) {
            // Strategy 3: Last resort — try fileReadOrder one more time before giving up
            if (state.fileReadOrder.length > 0) {
              const lastRead = state.fileReadOrder[state.fileReadOrder.length - 1]
              console.log(`[planner] LAST RESORT: ${tool} has NO path ${noPathCount} times — using last-read "${lastRead}"`)
              state.consecutiveFailures.delete(noPathKey)
              normalized.args = { ...args, path: lastRead }
              args = normalized.args
              path = lastRead
              state.pendingContext = `[PLANNER] RECOVERED: Your ${tool} was missing "path" ${noPathCount} times. Using "${lastRead}". ALWAYS include "path" in args.`
              // Fall through to downstream rules with fixed path
            } else {
              // Strategy 4: Programmatic fix — if error-autofix knows the exact fix, execute it directly
              const pendingErr = getPendingError(state.runId)
              const pendingContent = getPendingFileContent(state.runId)
              if (pendingErr && pendingContent && tool === "edit_file") {
                const programmaticFix = buildProgrammaticFix(pendingErr, pendingContent)
                if (programmaticFix) {
                  console.log(`[planner] PROGRAMMATIC FIX: bypassing AI — executing fix directly for "${pendingErr.sourceFile}"`)
                  state.consecutiveFailures.delete(noPathKey)
                  clearPendingFileContent(state.runId)
                  return programmaticFix
                }
              }

              console.log(`[planner] BLOCKED: ${tool} has NO path ${noPathCount} times — FORCE COMPLETING`)
              state.consecutiveFailures.delete(noPathKey)
              return {
                kind: "completed" as const,
                content: "The task could not be completed — the AI was unable to determine the correct file path. Please provide the exact file path in your prompt.",
                reasoning: `Terminated: ${tool} had no path argument ${noPathCount} times.`,
                usage: { inputTokens: 0, outputTokens: 0 }
              }
            }
          } else {
            console.log(`[planner] BLOCKED: ${tool} has NO path arg (${noPathCount}x) — redirecting to list_directory`)
            state.pendingContext = `[PLANNER] Your ${tool} call had NO "path" argument. Every file operation needs a path. Check the project structure, then retry with the correct path in args.`
            return {
              ...normalized,
              tool: "list_directory",
              args: { path: "." },
              tools: undefined,
              content: `${tool} blocked: missing "path" argument. Listing project to find correct path.`
            }
          }
        }
      }
    }

    // ─── Rule 1: Fix broken args ───
    if (TOOLS_NEEDING_PATH.has(tool) && !hasValidArgs(tool, args)) {
      return this.fixBrokenArgs(state, normalized)
    }

    // ─── Rule 2: Enforce read-before-edit ───
    if ((tool === "edit_file" || tool === "write_file") && path) {
      const hasBeenRead = state.fileReadContent.get(path)
      const fileKnownToExist = state.fileExists.get(path)

      // If editing a file we haven't read yet AND we know it exists → read first
      // (targeted edits ESPECIALLY need this — search text must match exactly)
      if (!hasBeenRead && fileKnownToExist !== false && tool === "edit_file") {
        console.log(`[planner] Enforcing read-before-edit for "${path}"`)
        const editModeHint = isTargetedEdit(args)
          ? `Now apply your edit using edit_file with search/replace. The "search" text must match EXACTLY what appears in the file.`
          : `Now apply your edit using edit_file with search/replace (preferred) or write_file with COMPLETE updated content.`
        state.pendingContext = `[PLANNER] You need to read "${path}" before editing it. The file content is shown above. ${editModeHint}`
        // Stash the edit intent so AI knows what to do after reading
        const editIntent = normalized.content || normalized.reasoning || ""
        if (editIntent) {
          state.pendingContext += `\nYour intended change was: ${editIntent.slice(0, 300)}`
        }
        return {
          ...normalized,
          tool: "read_file",
          args: { path },
          tools: undefined,
          content: `Reading "${path}" before editing (enforced by planner).`
        }
      }
    }

    // ─── Rule 3: Prevent reading files that don't exist ───
    if (tool === "read_file" && path && state.fileExists.get(path) === false) {
      console.log(`[planner] Preventing read of non-existent file "${path}" — suggesting write_file`)
      state.pendingContext = `[PLANNER] "${path}" does not exist (confirmed by previous attempts). Create it with write_file instead of trying to read it.`
      return {
        ...normalized,
        tool: "list_directory",
        args: { path: path.split("/").slice(0, -1).join("/") || "." },
        tools: undefined,
        content: `"${path}" does not exist. Listing parent directory.`
      }
    }

    // ─── Rule 4: Loop and oscillation detection ───
    const sig = getActionSignature(tool, args)
    state.lastNActions.push(sig)
    if (state.lastNActions.length > 20) state.lastNActions.shift()
    state.actionSignatures.push(sig)
    if (state.actionSignatures.length > 20) state.actionSignatures.shift()

    const loopResult = this.detectLoopOrOscillation(state, sig, tool, args)
    if (loopResult) return loopResult

    return normalized
  }

  private interceptParallel(state: PlannerState, normalized: NormalizedResponse): NormalizedResponse {
    if (!normalized.tools) return normalized

    // ─── Forced reconnaissance for parallel batches ───
    const hasWriteInBatch = normalized.tools.some((tc) => tc.tool === "write_file" || tc.tool === "edit_file")
    if (hasWriteInBatch && !state.hasPerformedAnyRead && state.hasExistingProject === true) {
      console.log(`[planner] Forcing reconnaissance: parallel batch has writes but no reads done yet`)
      state.pendingContext = `[PLANNER] You must read existing files before writing. The project already has code — understand it first.`
      return {
        ...normalized,
        tool: "list_directory",
        args: { path: "." },
        tools: undefined,
        content: "Reading project structure before making changes (enforced by planner)."
      }
    }

    // ─── Config file check: if any tool writes a config file, search first ───
    const configNeedingSearch = checkToolsForConfigFiles(state.runId, normalized.tools)
    if (configNeedingSearch) {
      console.log(`[planner] Parallel batch contains config file for ${configNeedingSearch.framework} — forcing web_search first`)
      const { override, pendingContext } = buildConfigSearchOverride(state.runId, configNeedingSearch, normalized)
      state.pendingContext = pendingContext
      return override
    }

    const fixedTools: ToolCall[] = []
    const readPaths: string[] = []
    const text = `${normalized.content || ""} ${normalized.reasoning || ""}`

    for (const tc of normalized.tools) {
      const path = tc.args?.path as string | undefined

      // Hard block: drop tools with completely missing path
      if (TOOLS_NEEDING_PATH.has(tc.tool) && !path) {
        console.log(`[planner] Dropping ${tc.tool} from parallel batch — no "path" arg`)
        state.pendingContext = (state.pendingContext || "") + `\n[PLANNER] Dropped ${tc.tool} — it had no "path" argument. Always include "path" in args.`
        continue
      }

      // Block banned commands in parallel batches
      if (tc.tool === "run_command") {
        const command = (tc.args?.command as string) || ""
        const banReason = isBannedCommand(command)
        if (banReason) {
          console.log(`[planner] Dropping banned command from parallel batch: "${command.slice(0, 80)}"`)
          state.pendingContext = (state.pendingContext || "") + `\n[PLANNER] Command BLOCKED: "${command.slice(0, 100)}". ${banReason}`
          continue
        }
      }

      // Import validation for write_file in parallel batches (warning only)
      if (tc.tool === "write_file" && path && tc.args?.content) {
        const importWarnings = validateImports(path, tc.args.content as string, state.fileExists)
        if (importWarnings.length > 0) {
          state.pendingContext = (state.pendingContext || "") + `\n[PLANNER] Import warnings for "${path}": ${importWarnings.join("; ")}`
        }
      }

      // Auto-escalate banned edits
      if (tc.tool === "edit_file" && path && state.bannedEdits.has(path) && tc.args?.patch) {
        fixedTools.push({ id: tc.id, tool: "write_file", args: { path, content: tc.args.patch } })
        continue
      }

      // Fix broken args
      if (TOOLS_NEEDING_PATH.has(tc.tool) && !hasValidArgs(tc.tool, tc.args)) {
        const paths = extractPathsFromText(text)
        const recoveredPath = paths.find((p) => !readPaths.includes(p)) || paths[0]

        if (recoveredPath) {
          const isBatchBrokenEdit = tc.tool === "edit_file" && !isTargetedEdit(tc.args) && !tc.args?.patch && !tc.args?.content
        if (isBatchBrokenEdit || (TOOLS_NEEDING_CONTENT.has(tc.tool) && !tc.args?.content)) {
            state.globalBrokenWriteCount++

            // If file doesn't exist, don't read it — just skip and warn
            const fileKnown = state.fileExists.get(recoveredPath)
            const isNewFile = fileKnown === false || (fileKnown === undefined && !state.fileReadContent.has(recoveredPath))

            if (isNewFile) {
              console.log(`[planner] Dropping broken parallel ${tc.tool} for new file "${recoveredPath}" — no content to write, nothing to read`)
              state.pendingContext = (state.pendingContext || "") + `\n[PLANNER] write_file for "${recoveredPath}" had NO CONTENT. This is a new file — provide "content" in "args".`
            } else {
              console.log(`[planner] Converting broken parallel ${tc.tool} → read_file: ${recoveredPath}`)
              fixedTools.push({ id: tc.id, tool: "read_file", args: { path: recoveredPath } })
              readPaths.push(recoveredPath)
            }
          } else {
            fixedTools.push({ id: tc.id, tool: tc.tool, args: { ...tc.args, path: recoveredPath } })
          }
        } else {
          console.log(`[planner] Dropping unrecoverable parallel ${tc.tool}`)
        }
        continue
      }

      // Prevent reading non-existent files
      if (tc.tool === "read_file" && path && state.fileExists.get(path) === false) {
        console.log(`[planner] Dropping read of non-existent "${path}" from parallel batch`)
        continue
      }

      fixedTools.push(tc)
    }

    // Check global broken-write threshold for parallel batches too
    if (state.globalBrokenWriteCount >= 3) {
      state.fatalTermination = true
      console.error(`[planner] FATAL: Model has sent ${state.globalBrokenWriteCount} write/edit calls with NO content (parallel). Terminating run.`)
      return {
        kind: "completed" as const,
        content: `The AI model was unable to produce file contents after ${state.globalBrokenWriteCount} attempts. This is a model-level limitation. Please try again — the model may perform better on retry.`,
        reasoning: `Terminated: ${state.globalBrokenWriteCount} write/edit calls with null content.`,
        usage: { inputTokens: 0, outputTokens: 0 }
      }
    }

    if (fixedTools.length === 0) {
      return {
        ...normalized,
        tool: "list_directory",
        args: { path: "." },
        tools: undefined,
        content: "All parallel tool calls had broken args. Checking project state."
      }
    }

    if (readPaths.length > 0) {
      state.pendingContext = `[PLANNER] Your edit/write calls for ${readPaths.join(", ")} had broken args. The files were read instead. Use write_file with COMPLETE content to apply your changes.`
      state.interceptionCount++
    }

    normalized.tools = fixedTools
    normalized.tool = fixedTools[0].tool
    normalized.args = fixedTools[0].args
    return normalized
  }

  // ═══ RECOVERY STRATEGIES ═══

  private fixBrokenArgs(state: PlannerState, normalized: NormalizedResponse): NormalizedResponse {
    const tool = normalized.tool || ""
    const text = `${normalized.content || ""} ${normalized.reasoning || ""}`
    const paths = extractPathsFromText(text)

    // ─── Global broken-args counter: detect model-level inability to produce content ───
    const nArgs = normalized.args || {}
    const editHasNoContent = tool === "edit_file" && !isTargetedEdit(nArgs) && !nArgs.patch && !nArgs.content
    if ((TOOLS_NEEDING_CONTENT.has(tool) && !normalized.args?.content) || editHasNoContent) {
      state.globalBrokenWriteCount++
      if (state.globalBrokenWriteCount >= 3) {
        console.error(`[planner] FATAL: Model has sent ${state.globalBrokenWriteCount} write/edit calls with NO content. Terminating run.`)
        state.fatalTermination = true  // Signal to bypass verification guard
        return {
          kind: "completed" as const,
          content: `The AI model was unable to produce file contents after ${state.globalBrokenWriteCount} attempts. This is a model-level limitation — the model cannot encode large file content in its response format. Please try again, or try a different model (e.g., gemini-pro).`,
          reasoning: `Terminated: ${state.globalBrokenWriteCount} consecutive write/edit calls with null content.`,
          usage: { inputTokens: 0, outputTokens: 0 }
        }
      }
    }

    if (paths.length === 0) {
      console.log(`[planner] Cannot recover path for ${tool} — falling back to list_directory`)
      return {
        ...normalized,
        tool: "list_directory",
        args: { path: "." },
        tools: undefined,
        content: `Could not determine file path for ${tool}. Checking project state.`
      }
    }

    const path = paths[0]
    const fileKey = `${tool}:${path}`
    const count = state.maxInterceptionsPerFile.get(fileKey) || 0
    if (count >= 3) {
      console.log(`[planner] Max interceptions reached for ${fileKey} — BREAKING LOOP, skipping this file`)
      state.maxInterceptionsPerFile.delete(fileKey)
      state.pendingContext = `[PLANNER] LOOP BROKEN: "${path}" failed ${count} times with broken args. SKIP this file and move on to the next task. Do NOT try to write/edit "${path}" again.`
      return {
        ...normalized,
        tool: "list_directory",
        args: { path: path.split("/").slice(0, -1).join("/") || "." },
        tools: undefined,
        content: `Loop broken: "${path}" failed ${count}+ times. Skipping and moving on.`
      }
    }
    state.maxInterceptionsPerFile.set(fileKey, count + 1)
    state.interceptionCount++

    // edit_file/write_file: content irrecoverable (skip for targeted edit modes)
    const fixArgs = normalized.args || {}
    const isBrokenEdit = tool === "edit_file" && !isTargetedEdit(fixArgs) && !fixArgs.patch && !fixArgs.content
    if (isBrokenEdit || (TOOLS_NEEDING_CONTENT.has(tool) && !normalized.args?.content)) {
      if (tool === "edit_file") state.bannedEdits.add(path)

      // Check if file exists: known false OR never seen (new file)
      const fileKnown = state.fileExists.get(path)
      const isNewFile = fileKnown === false || (fileKnown === undefined && !state.fileReadContent.has(path))

      if (isNewFile) {
        // File doesn't exist — reading it would just ENOENT. Tell the AI to use smaller writes.
        console.log(`[planner] Broken ${tool} for "${path}" (new file) — requesting split approach`)
        state.pendingContext = `[PLANNER] CRITICAL: Your write_file for "${path}" had NO CONTENT — the args_json was empty.

This usually happens because the file content is too large for args_json. USE THIS APPROACH:

1. Write a SMALL skeleton file first (just imports + empty function + export, ~10-20 lines)
2. Then use edit_file insert_at to add sections one at a time

OR split into separate component files — e.g., instead of one huge App.tsx, create:
  - src/components/Navbar.tsx
  - src/components/Hero.tsx
  - src/components/Features.tsx
  - src/App.tsx (just imports and assembles them)

Each file stays under 80 lines → args_json can handle it.`
        return {
          ...normalized,
          tool: "list_directory",
          args: { path: path.split("/").slice(0, -1).join("/") || "." },
          tools: undefined,
          content: `"${path}" write failed — content too large for args_json. Use split approach.`
        }
      }

      // File exists — if already read this run, don't re-read (prevents infinite loop)
      if (state.fileReadContent.has(path)) {
        console.log(`[planner] Broken ${tool} for "${path}" — already read, giving stronger hint`)
        state.pendingContext = `[PLANNER] CRITICAL: Your ${tool} for "${path}" had NO CONTENT — the "content" field was null/missing.
You already read this file. Do NOT read it again.
Your args_json must contain the "content" field with the complete file source code.
Example: { "path": "${path}", "content": "import React from 'react';\\n..." }
If you cannot produce the content, SKIP this file and move on.`
        return {
          ...normalized,
          tool: "list_directory",
          args: { path: path.split("/").slice(0, -1).join("/") || "." },
          tools: undefined,
          content: `"${path}" already read — provide content in your write_file args.`
        }
      }

      // File exists but not yet read — read it first so AI can write with full content
      console.log(`[planner] Converting broken ${tool} → read_file "${path}"`)
      state.pendingContext = `[PLANNER] Your write_file for "${path}" had NO CONTENT. The file exists — its content is shown above. Now use write_file with BOTH "path" and "content" in args (NOT args_json).`
      return {
        ...normalized,
        tool: "read_file",
        args: { path },
        tools: undefined,
        content: `Reading "${path}" first (${tool} args were broken).`
      }
    }

    // Other tools: just fix the path
    console.log(`[planner] Recovered path "${path}" for ${tool}`)
    normalized.args = { ...normalized.args, path }
    return normalized
  }

  private detectLoopOrOscillation(state: PlannerState, sig: string, tool: string, args: Record<string, unknown>): NormalizedResponse | null {
    const history = state.lastNActions
    const path = args.path as string | undefined

    // ─── Consecutive repetition (A→A→A) ───
    let consecutiveRepeats = 0
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i] === sig) consecutiveRepeats++
      else break
    }

    if (consecutiveRepeats >= 3) {
      return this.breakLoop(state, sig, tool, path, consecutiveRepeats, "consecutive")
    }

    // ─── Oscillation detection (A→B→A→B) ───
    if (history.length >= 4) {
      const last4 = history.slice(-4)
      if (last4[0] === last4[2] && last4[1] === last4[3] && last4[0] !== last4[1]) {
        return this.breakLoop(state, sig, tool, path, 4, "oscillation")
      }
    }

    // ─── Broader pattern: same path with different tools failing repeatedly ───
    if (path) {
      const recentForPath = state.toolFailures
        .filter((f) => f.path === path && Date.now() - f.timestamp < 120_000)
      if (recentForPath.length >= 4) {
        console.log(`[planner] Path "${path}" has ${recentForPath.length} recent failures across tools — escalating`)
        state.bannedEdits.add(path)
        state.pendingContext = `[PLANNER] "${path}" has failed ${recentForPath.length} times with various tools. Use write_file with COMPLETE content. If the file doesn't exist, create it from scratch.`
        state.lastNActions = [] // reset

        return {
          kind: "needs_tool",
          tool: state.fileExists.get(path) === false ? "list_directory" : "read_file",
          args: { path: state.fileExists.get(path) === false ? (path.split("/").slice(0, -1).join("/") || ".") : path },
          content: `Multiple failures on "${path}". Reading current state to try a clean approach.`,
          reasoning: "Breaking failure pattern — too many errors on this file.",
          usage: { inputTokens: 0, outputTokens: 0 }
        }
      }
    }

    return null
  }

  private breakLoop(
    state: PlannerState,
    sig: string,
    tool: string,
    path: string | undefined,
    repeats: number,
    pattern: "consecutive" | "oscillation"
  ): NormalizedResponse {
    console.log(`[planner] ${pattern.toUpperCase()} DETECTED: "${sig}" (${repeats}x)`)

    const failCount = (state.consecutiveFailures.get(sig) || 0) + 1
    state.consecutiveFailures.set(sig, failCount)
    state.lastNActions = [] // reset to prevent re-trigger

    if ((tool === "edit_file" || tool === "write_file") && path) {
      state.bannedEdits.add(path)
      const fileKnown = state.fileExists.get(path)
      const isNewFile = fileKnown === false || (fileKnown === undefined && !state.fileReadContent.has(path))

      if (isNewFile) {
        state.pendingContext = `[PLANNER] ${pattern.toUpperCase()} BROKEN for "${path}". This is a NEW file — nothing to read. Your write_file calls have NO CONTENT in args. You MUST include "content" directly in "args": {"path": "${path}", "content": "..."}. Do NOT use args_json.`
        return {
          kind: "needs_tool",
          tool: "list_directory",
          args: { path: path.split("/").slice(0, -1).join("/") || "." },
          content: `${pattern.toUpperCase()} BROKEN: "${path}" is new (nothing to read). Fix your args format.`,
          reasoning: `Breaking ${pattern}. ${tool} failed ${repeats} times on new file ${path}.`,
          usage: { inputTokens: 0, outputTokens: 0 }
        }
      }

      state.pendingContext = `[PLANNER] ${pattern.toUpperCase()} BROKEN: ${tool} on "${path}" repeated ${repeats} times. edit_file is now BANNED for this file. Use write_file with COMPLETE content in args (NOT args_json).`
      return {
        kind: "needs_tool",
        tool: "read_file",
        args: { path },
        content: `${pattern.toUpperCase()} BROKEN: Reading "${path}" to try write_file instead.`,
        reasoning: `Breaking ${pattern}. ${tool} failed ${repeats} times on ${path}.`,
        usage: { inputTokens: 0, outputTokens: 0 }
      }
    }

    if (tool === "read_file" && path) {
      state.fileExists.set(path, false) // assume it doesn't exist
      const dir = path.split("/").slice(0, -1).join("/") || "."
      state.pendingContext = `[PLANNER] ${pattern.toUpperCase()} BROKEN: "${path}" likely does not exist. Create it with write_file.`
      return {
        kind: "needs_tool",
        tool: "list_directory",
        args: { path: dir },
        content: `${pattern.toUpperCase()} BROKEN: "${path}" doesn't exist. Listing "${dir}".`,
        reasoning: `Breaking ${pattern} — file doesn't exist.`,
        usage: { inputTokens: 0, outputTokens: 0 }
      }
    }

    // list_directory looping means the AI is stuck — force completion after 2nd breakLoop trigger
    if (tool === "list_directory" && failCount >= 2) {
      console.log(`[planner] list_directory loop detected ${failCount} times — FORCE COMPLETING`)
      return {
        kind: "completed" as const,
        content: "The task could not be completed — the AI agent entered a navigation loop. Please try again with a more specific prompt.",
        reasoning: `Terminated: list_directory looped ${failCount} breakLoop cycles.`,
        usage: { inputTokens: 0, outputTokens: 0 }
      }
    }

    // If breaking a run_command loop, mark scaffold as abandoned
    if (tool === "run_command" && (state.scaffoldDirectory || state.stashedScaffoldCommand)) {
      state.scaffoldAbandoned = true
      state.stashedScaffoldCommand = null
      const rootHint = state.scaffoldDirectory ? ` Ignore the "${state.scaffoldDirectory}/" directory. Write files at project root.` : ""
      state.pendingContext = `[PLANNER] ${pattern.toUpperCase()} BROKEN: Scaffolding command failed ${repeats} times. ABANDON scaffolding approach. Create all files manually with write_file at the project ROOT.${rootHint}`
      console.log(`[planner] Scaffold ABANDONED due to ${pattern} in run_command`)
    } else if (tool === "list_directory") {
      // Don't break a list_directory loop with another list_directory — give the AI a useful hint
      state.pendingContext = `[PLANNER] STUCK: You are repeating list_directory. Stop listing and proceed with the actual task. Use write_file or edit_file to create or modify files.`
      return {
        kind: "needs_tool",
        tool: "search_files",
        args: { query: "*", glob: "src/**" },
        content: `${pattern.toUpperCase()} BROKEN: list_directory loop. Switching to search to find what you need.`,
        reasoning: `Breaking ${pattern} on list_directory.`,
        usage: { inputTokens: 0, outputTokens: 0 }
      }
    } else {
      state.pendingContext = `[PLANNER] ${pattern.toUpperCase()} BROKEN: "${tool}" repeated ${repeats} times. Try a different approach.`
    }

    return {
      kind: "needs_tool",
      tool: "list_directory",
      args: { path: "." },
      content: `${pattern.toUpperCase()} BROKEN: "${tool}" repeated ${repeats} times. Checking project state.`,
      reasoning: `Breaking ${pattern} on ${tool}.`,
      usage: { inputTokens: 0, outputTokens: 0 }
    }
  }
}

/** Singleton instance */
export const actionPlanner = new ActionPlanner()
