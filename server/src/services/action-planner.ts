/**
 * Action Planner — intelligent orchestration layer between AI model and tool execution.
 *
 * This is NOT a prompt hack. It's a programmatic system that:
 * 1. Intercepts every AI tool call before it reaches the client
 * 2. Detects broken args, loops, and stuck states
 * 3. Transforms broken calls into working multi-step sequences
 * 4. Tracks intent history and provides context enrichment
 *
 * The AI model is unreliable at formatting tool args (especially Gemini structured output).
 * This layer ensures tools execute correctly regardless of model quality.
 */

import type { NormalizedResponse, ToolCall } from "../types.js"

// ─── Types ───

interface Intent {
  tool: string
  path?: string
  operation: "read" | "write" | "edit" | "delete" | "command" | "search" | "navigate" | "other"
  timestamp: number
}

interface PlannerState {
  runId: string
  intents: Intent[]
  actionSignatures: string[]         // "edit_file:src/app.ts" history
  consecutiveFailures: Map<string, number>
  pendingContext: string | null       // message to inject into next tool result
  interceptionCount: number
  maxInterceptionsPerFile: Map<string, number>
}

// ─── Path extraction utility ───

const PATH_PATTERNS = [
  // Explicit tool references: "read frontend/src/app/auth.ts"
  /(?:read|edit|write|update|modify|fix|create|delete|check|open)\s+[`'"]*([a-zA-Z0-9_./\\-]+\.[a-zA-Z]{1,6})[`'"]*(?:\s|$|,|\.)/gi,
  // Backtick-quoted paths: `frontend/src/app/auth.ts`
  /`([a-zA-Z0-9_./\\-]+\.[a-zA-Z]{1,6})`/g,
  // Paths starting with known directories
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
  if (tool === "write_file") return "write"
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
        maxInterceptionsPerFile: new Map()
      })
    }
    return this.state.get(runId)!
  }

  /**
   * Intercept an AI response before it reaches the client.
   * Fixes broken tool calls, detects loops, transforms actions.
   */
  intercept(runId: string, normalized: NormalizedResponse): NormalizedResponse {
    if (normalized.kind !== "needs_tool") return normalized

    const state = this.getState(runId)
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

  private interceptSingle(state: PlannerState, normalized: NormalizedResponse): NormalizedResponse {
    const tool = normalized.tool || ""
    const args = normalized.args || {}

    // ─── Rule 1: Fix broken args ───
    if (TOOLS_NEEDING_PATH.has(tool) && !hasValidArgs(tool, args)) {
      return this.fixBrokenArgs(state, normalized)
    }

    // ─── Rule 2: Loop detection ───
    const sig = getActionSignature(tool, args)
    state.actionSignatures.push(sig)
    if (state.actionSignatures.length > 15) state.actionSignatures.shift()

    const loopResult = this.detectLoop(state, sig, tool, args)
    if (loopResult) return loopResult

    // Reset failure counter on new action
    state.consecutiveFailures.delete(sig)

    return normalized
  }

  private interceptParallel(state: PlannerState, normalized: NormalizedResponse): NormalizedResponse {
    if (!normalized.tools) return normalized

    const fixedTools: ToolCall[] = []
    const readPaths: string[] = [] // files we need to read instead of edit

    for (const tc of normalized.tools) {
      if (TOOLS_NEEDING_PATH.has(tc.tool) && !hasValidArgs(tc.tool, tc.args)) {
        // Broken tool in batch — try to recover
        const text = `${normalized.content || ""} ${normalized.reasoning || ""}`
        const paths = extractPathsFromText(text)
        const path = paths.find((p) => !readPaths.includes(p)) || paths[0]

        if (path) {
          if (TOOLS_NEEDING_PATCH.has(tc.tool) || TOOLS_NEEDING_CONTENT.has(tc.tool)) {
            // Can't recover content — convert to read
            console.log(`[planner] Converting broken parallel ${tc.tool} to read_file: ${path}`)
            fixedTools.push({ id: tc.id, tool: "read_file", args: { path } })
            readPaths.push(path)
          } else {
            // Just needs a path (read_file, delete_file, etc.)
            fixedTools.push({ id: tc.id, tool: tc.tool, args: { ...tc.args, path } })
          }
        } else {
          // Can't recover at all — drop this tool
          console.log(`[planner] Dropping broken parallel ${tc.tool} — no path recoverable`)
        }
      } else {
        fixedTools.push(tc)
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

    // If we converted some edits to reads, set pending context for next turn
    if (readPaths.length > 0) {
      state.pendingContext = `[PLANNER] Your previous edit/write calls for ${readPaths.join(", ")} had broken args (missing content). The files were read instead. Use the content above to write your changes with write_file.`
      state.interceptionCount++
    }

    normalized.tools = fixedTools
    normalized.tool = fixedTools[0].tool
    normalized.args = fixedTools[0].args
    return normalized
  }

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

    // Check interception cap per file (prevent infinite read → broken edit → read loops)
    const fileKey = `${tool}:${path}`
    const count = state.maxInterceptionsPerFile.get(fileKey) || 0
    if (count >= 5) {
      console.log(`[planner] Max interceptions (${count}) reached for ${fileKey} — letting it fail`)
      return normalized // let the broken call through, error will reach AI naturally
    }
    state.maxInterceptionsPerFile.set(fileKey, count + 1)
    state.interceptionCount++

    // For edit_file/write_file: content is irrecoverable, convert to read_file
    if (TOOLS_NEEDING_PATCH.has(tool) || (TOOLS_NEEDING_CONTENT.has(tool) && !normalized.args?.content)) {
      console.log(`[planner] Converting broken ${tool} → read_file for "${path}" (content irrecoverable)`)
      state.pendingContext = `[PLANNER] You tried to ${tool === "edit_file" ? "edit" : "write"} "${path}" but the tool args were broken (patch/content was null). The file content is shown above. Now write your changes using write_file with the COMPLETE new file content. Do NOT use edit_file — use write_file instead.`

      return {
        ...normalized,
        tool: "read_file",
        args: { path },
        tools: undefined,
        content: `Reading "${path}" first (${tool} args were broken — content missing).`
      }
    }

    // For other tools (read_file, delete_file, etc.): just fix the path
    console.log(`[planner] Recovered path "${path}" for ${tool}`)
    normalized.args = { ...normalized.args, path }
    return normalized
  }

  private detectLoop(state: PlannerState, sig: string, tool: string, args: Record<string, unknown>): NormalizedResponse | null {
    // Count consecutive same signatures
    const history = state.actionSignatures
    let repeats = 0
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i] === sig) repeats++
      else break
    }

    if (repeats < 3) return null

    const path = args.path as string | undefined
    console.log(`[planner] LOOP DETECTED: "${sig}" repeated ${repeats} times`)

    // Track and limit loop breaks
    const failCount = (state.consecutiveFailures.get(sig) || 0) + 1
    state.consecutiveFailures.set(sig, failCount)

    // Clear the signature history to prevent immediate re-trigger
    state.actionSignatures = []

    if ((tool === "edit_file" || tool === "write_file") && path) {
      state.pendingContext = `[PLANNER] LOOP BROKEN: ${tool} on "${path}" failed ${repeats} times in a row. The file was read instead. Use write_file (NOT edit_file) with the COMPLETE file content to make your changes.`
      return {
        kind: "needs_tool",
        tool: "read_file",
        args: { path },
        content: `LOOP BROKEN: ${tool} failed ${repeats} times. Reading "${path}" to try a different approach.`,
        reasoning: `Breaking infinite loop. Previous ${repeats} attempts at ${tool} on ${path} all failed.`,
        usage: { inputTokens: 0, outputTokens: 0 }
      }
    }

    if (tool === "read_file" && path) {
      // File probably doesn't exist — suggest creating it
      const dir = path.split("/").slice(0, -1).join("/") || "."
      state.pendingContext = `[PLANNER] LOOP BROKEN: read_file on "${path}" failed ${repeats} times. The file likely does not exist. Create it with write_file.`
      return {
        kind: "needs_tool",
        tool: "list_directory",
        args: { path: dir },
        content: `LOOP BROKEN: "${path}" might not exist. Listing "${dir}" to check.`,
        reasoning: `Breaking loop — file might not exist.`,
        usage: { inputTokens: 0, outputTokens: 0 }
      }
    }

    // Generic fallback
    return {
      kind: "needs_tool",
      tool: "list_directory",
      args: { path: "." },
      content: `LOOP BROKEN: "${tool}" failed ${repeats} times. Checking project state.`,
      reasoning: `Breaking infinite loop on ${tool}.`,
      usage: { inputTokens: 0, outputTokens: 0 }
    }
  }

  /**
   * Get context to inject into the next tool result message.
   * Called by buildToolResultMessage in base-provider.
   */
  getPendingContext(runId: string): string | null {
    const state = this.state.get(runId)
    if (!state || !state.pendingContext) return null
    const ctx = state.pendingContext
    state.pendingContext = null // consume once
    return ctx
  }

  /** Get stats for logging */
  getStats(runId: string): { interceptions: number; intents: number } {
    const state = this.state.get(runId)
    return {
      interceptions: state?.interceptionCount || 0,
      intents: state?.intents.length || 0
    }
  }

  /** Cleanup on run completion */
  clear(runId: string): void {
    this.state.delete(runId)
  }
}

/** Singleton instance */
export const actionPlanner = new ActionPlanner()
