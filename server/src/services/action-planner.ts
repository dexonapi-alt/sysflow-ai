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

  // ─── NEW: Smart awareness ───

  // File state cache: track which files we KNOW exist or don't
  fileExists: Map<string, boolean>     // path → exists
  fileReadContent: Map<string, boolean> // path → has been read this run (AI has context)

  // Error pattern tracking
  toolFailures: ToolFailure[]          // recent failures
  bannedEdits: Set<string>             // paths where edit_file is permanently banned → use write_file

  // Oscillation detection
  lastNActions: string[]               // last 10 action signatures for pattern matching
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

// ─── Tool classification ───

const TOOLS_NEEDING_PATH = new Set(["read_file", "write_file", "edit_file", "create_directory", "delete_file", "move_file", "file_exists"])
const TOOLS_NEEDING_CONTENT = new Set(["write_file"])
const TOOLS_NEEDING_PATCH = new Set(["edit_file"])

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
  if (TOOLS_NEEDING_PATCH.has(tool) && !args.patch) return false
  return true
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
        toolFailures: [],
        bannedEdits: new Set(),
        lastNActions: []
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

    // Update file existence cache
    if (path) {
      if (tool === "write_file" || tool === "edit_file" || tool === "create_directory") {
        if (success) state.fileExists.set(path, true)
      }
      if (tool === "read_file" && success) {
        state.fileExists.set(path, true)
        state.fileReadContent.set(path, true)
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

  /** Cleanup on run completion */
  clear(runId: string): void {
    this.state.delete(runId)
  }

  // ═══ INTERCEPTION RULES ═══

  private interceptSingle(state: PlannerState, normalized: NormalizedResponse): NormalizedResponse {
    const tool = normalized.tool || ""
    const args = normalized.args || {}
    const path = args.path as string | undefined

    // ─── Rule 0: Auto-escalate edit_file → write_file for banned paths ───
    if (tool === "edit_file" && path && state.bannedEdits.has(path)) {
      console.log(`[planner] Auto-escalating edit_file → write_file for banned path "${path}"`)
      // If it has valid patch, convert to write_file with content = patch
      if (args.patch) {
        normalized.tool = "write_file"
        normalized.args = { path, content: args.patch }
        state.pendingContext = `[PLANNER] edit_file was auto-converted to write_file for "${path}" because previous edits kept failing.`
        return normalized
      }
      // If no patch (broken args), will be caught by Rule 1
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
      if (!hasBeenRead && fileKnownToExist !== false && tool === "edit_file") {
        console.log(`[planner] Enforcing read-before-edit for "${path}"`)
        state.pendingContext = `[PLANNER] You need to read "${path}" before editing it. The file content is shown above. Now apply your edit using write_file with the COMPLETE updated content.`
        // Stash the edit intent so AI knows what to do after reading
        const editHint = normalized.content || normalized.reasoning || ""
        if (editHint) {
          state.pendingContext += `\nYour intended change was: ${editHint.slice(0, 300)}`
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

    const fixedTools: ToolCall[] = []
    const readPaths: string[] = []
    const text = `${normalized.content || ""} ${normalized.reasoning || ""}`

    for (const tc of normalized.tools) {
      const path = tc.args?.path as string | undefined

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
          if (TOOLS_NEEDING_PATCH.has(tc.tool) || (TOOLS_NEEDING_CONTENT.has(tc.tool) && !tc.args?.content)) {
            console.log(`[planner] Converting broken parallel ${tc.tool} → read_file: ${recoveredPath}`)
            fixedTools.push({ id: tc.id, tool: "read_file", args: { path: recoveredPath } })
            readPaths.push(recoveredPath)
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
    if (count >= 5) {
      console.log(`[planner] Max interceptions reached for ${fileKey} — letting it fail naturally`)
      return normalized
    }
    state.maxInterceptionsPerFile.set(fileKey, count + 1)
    state.interceptionCount++

    // edit_file/write_file: content irrecoverable → read first
    if (TOOLS_NEEDING_PATCH.has(tool) || (TOOLS_NEEDING_CONTENT.has(tool) && !normalized.args?.content)) {
      console.log(`[planner] Converting broken ${tool} → read_file "${path}"`)

      // Ban edit_file for this path going forward
      if (tool === "edit_file") {
        state.bannedEdits.add(path)
      }

      state.pendingContext = `[PLANNER] You tried to ${tool === "edit_file" ? "edit" : "write"} "${path}" but the args were broken (content was null). The file content is above. Use write_file (NOT edit_file) with the COMPLETE new content.`

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
      state.pendingContext = `[PLANNER] ${pattern.toUpperCase()} BROKEN: ${tool} on "${path}" repeated ${repeats} times. edit_file is now BANNED for this file. Use write_file with COMPLETE content.`
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
