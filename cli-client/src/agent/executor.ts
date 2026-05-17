import fs from "node:fs/promises"
import path from "node:path"
import readline from "node:readline"
import chalk from "chalk"
import { callServer, callServerStream } from "../lib/server.js"
import {
  listDirectoryTool,
  fileExistsTool,
  createDirectoryTool,
  readFileTool,
  writeFileTool,
  editFileTool,
  moveFileTool,
  deleteFileTool,
  searchCodeTool,
  runCommandTool,
  searchFilesTool,
  webSearchTool,
  recoverFromCommandError,
  searchForCommandFix,
  setBatchWritePaths,
  clearBatchWritePaths,
  INTERACTIVE_PATTERNS
} from "./tools.js"
import { runVerification } from "./verifier.js"
import { createSnapshot, cleanupSnapshot, rollback, getSnapshot, detectGit } from "./git.js"
import { lintFile, lintFiles, displayLintErrors, resetTscCache } from "./lint.js"
import { partitionToolCalls, getToolMeta, groupForParallelExecution, KNOWN_TOOL_NAMES, isKnownTool } from "./tool-meta.js"
import { validateToolInput } from "./validate-tool-input.js"
import { checkPermissions, loadRules, saveRule, lookupAnswer, rememberAnswer, primaryPath, type Rule } from "./permissions.js"
import { getSysbasePath, getPermissionMode, getSafeCommandsAutoApprove } from "../lib/sysbase.js"
import { askPermission } from "../cli/permission-prompt.js"
import { runHooks } from "./hooks.js"
import { registerBuiltinHooks } from "./builtin-hooks.js"

registerBuiltinHooks()

interface ToolResponse {
  tool: string
  args: Record<string, unknown>
  runId: string
  [key: string]: unknown
}

interface ToolCallEntry {
  id: string
  tool: string
  args: Record<string, unknown>
}

// ─── Local tool execution (no server call) ───

async function callReasonEndpoint(args: Record<string, unknown>, runId?: string): Promise<Record<string, unknown>> {
  const { getAuthToken, getSysbasePath, getSelectedModel } = await import("../lib/sysbase.js")
  const SERVER_URL = process.env.SYS_SERVER_URL || "http://localhost:4000"
  const token = (await getAuthToken()) || process.env.SYS_TOKEN || ""
  const model = await getSelectedModel()

  const payload = {
    runId: runId ?? "no-run",
    question: args.question,
    context: args.context,
    options: args.options,
    kind: args.kind,
    cwd: process.cwd(),
    sysbasePath: getSysbasePath(),
    model,
  }
  try {
    const res = await fetch(`${SERVER_URL}/reason`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    })
    if (!res.ok) {
      const text = await res.text()
      return { error: `reason endpoint failed: ${res.status} ${text.slice(0, 200)}`, success: false }
    }
    const data = await res.json() as Record<string, unknown>
    return data
  } catch (err) {
    return { error: `reason endpoint unreachable: ${(err as Error).message}`, success: false }
  }
}

async function resolvePermission(tool: string, args: Record<string, unknown>, runId?: string): Promise<"allow" | "deny"> {
  const mode = await getPermissionMode()
  const sysbasePath = getSysbasePath()
  const rules: Rule[] = await loadRules(sysbasePath)
  const target = primaryPath(tool, args)
  const runScope = runId ?? "no-run"

  // Run-scoped cache hit (e.g., user previously chose 'allow once' for this tool/path).
  const cached = lookupAnswer(runScope, tool, target)
  if (cached === "allow") return "allow"
  if (cached === "deny") return "deny"

  // Stage 2 of command-first-investigation: read the sysbase setting so
  // checkPermissions knows whether to auto-approve safe read-only
  // commands. Defaults to true when the setting is missing.
  const autoApproveSafeCommands = await getSafeCommandsAutoApprove()
  const decision = checkPermissions({ tool, args, mode, rules, autoApproveSafeCommands })
  if (decision.source === "tool_default" && decision.decision === "allow" && tool === "run_command") {
    console.log(`[permissions] safe-command auto-approved: ${(args.command as string | undefined)?.slice(0, 80) ?? "?"}`)
  }
  if (decision.decision === "allow") return "allow"
  if (decision.decision === "deny") return "deny"

  // 'ask' — prompt interactively; persist if requested.
  const promptResult = await askPermission({ tool, args })
  if (promptResult.persist) {
    await saveRule(sysbasePath, { tool, pattern: promptResult.pattern, decision: promptResult.decision })
  }
  rememberAnswer(runScope, tool, target, promptResult.decision)
  return promptResult.decision === "allow" ? "allow" : "deny"
}

export async function executeToolLocally(tool: string, args: Record<string, unknown>, runId?: string): Promise<Record<string, unknown>> {
  if (!args) args = {}

  // ─── Zod-driven validation: structured error if args don't match the schema ───
  const validated = validateToolInput<Record<string, unknown>>(tool, args)
  if (!validated.ok) {
    return {
      error: validated.error.hint,
      success: false,
      _errorCategory: "validation",
      _validation: {
        tool: validated.error.tool,
        field: validated.error.field,
        expected: validated.error.expected,
        issues: validated.error.issues,
      },
    }
  }
  args = validated.args

  // ─── Pre-tool-use hooks: may override permission or prevent execution ───
  const preHooks = await runHooks("pre_tool_use", { event: "pre_tool_use", tool, args, runId })
  if (preHooks.prevent) {
    return {
      error: `⛔ HOOK PREVENTED: tool "${tool}" was blocked by a pre-tool-use hook (${preHooks.notes.map((n) => n.source).join(", ") || "unknown"}).`,
      success: false,
      _errorCategory: "permission",
      _hookNotes: preHooks.notes,
    }
  }

  // ─── Permission gate: hook override > rule > tool default ───
  let permResult: "allow" | "deny"
  if (preHooks.override === "allow") permResult = "allow"
  else if (preHooks.override === "deny") permResult = "deny"
  else permResult = await resolvePermission(tool, args, runId)

  if (permResult === "deny") {
    return {
      error: `⛔ PERMISSION DENIED: tool "${tool}" was denied by the active permission policy.`,
      success: false,
      _errorCategory: "permission",
      _hookNotes: preHooks.notes.length > 0 ? preHooks.notes : undefined,
    }
  }

  // Helper to wrap any branch's return so post-hooks fire.
  const finalize = async (result: Record<string, unknown>): Promise<Record<string, unknown>> => {
    // Stage 5 of code-correctness plan: account for stripped imports
    // in this tool's result. Single accounting point — every tool's
    // result passes through finalize, so we never double-count or
    // miss strips from any write/edit code path.
    bumpImportsStrippedCount(countStrippedInResult(result))
    const event = result.success === false || result.error ? "post_tool_use_failure" : "post_tool_use"
    await runHooks(event, { event, tool, args, runId, result })
    return result
  }

  // The dispatch switch below historically returns directly. We wrap each
  // branch's return value through `finalize` via the trailing `_finalized`
  // marker — simpler than rewriting every case, post-hooks fire after the
  // switch via the wrapper at the bottom of the function.
  let dispatched: Record<string, unknown>
  try {
    dispatched = await dispatch(tool, args, runId)
  } catch (err) {
    const errResult = { error: (err as Error).message, success: false }
    await runHooks("post_tool_use_failure", { event: "post_tool_use_failure", tool, args, runId, result: errResult, error: err as Error })
    throw err
  }
  return finalize(dispatched)
}

async function dispatch(tool: string, args: Record<string, unknown>, runId?: string): Promise<Record<string, unknown>> {
  // Phase 5: self-invoked reasoning tool — forwarded to the server's /reason endpoint.
  if (tool === "reason") {
    return await callReasonEndpoint(args, runId)
  }

  // Phase 7: in-process JobRegistry poll. Never goes through the server.
  if (tool === "check_jobs") {
    const { poll, list } = await import("./background-jobs.js")
    const targetRun = runId ?? "no-run"
    if (typeof args.jobId === "string" && args.jobId) {
      const job = poll(args.jobId)
      return job ? { ok: true, job } : { ok: false, error: `unknown jobId: ${args.jobId}` }
    }
    const jobs = list(targetRun)
    return {
      ok: true,
      jobs,
      summary: `${jobs.length} job(s); ${jobs.filter((j) => j.status === "running").length} running, ${jobs.filter((j) => j.status === "done").length} done, ${jobs.filter((j) => j.status === "failed").length} failed`,
    }
  }

  switch (tool) {
    case "list_directory": {
      const entries = await listDirectoryTool(args.path as string)
      return { path: args.path, entries }
    }

    case "file_exists": {
      const exists = await fileExistsTool(args.path as string)
      return { path: args.path, exists }
    }

    case "create_directory": {
      await createDirectoryTool(args.path as string)
      return { path: args.path, success: true }
    }

    case "read_file": {
      const result = await readFileTool(
        args.path as string,
        args.offset as number | undefined,
        args.limit as number | undefined
      )
      return { path: args.path, content: result.content, totalLines: result.totalLines, truncated: result.truncated, startLine: result.startLine }
    }

    case "batch_read": {
      const results: Array<{ path: string; content?: string; totalLines?: number; truncated?: boolean; error?: string; success: boolean }> = []
      for (const filePath of args.paths as string[]) {
        try {
          const result = await readFileTool(filePath)
          results.push({ path: filePath, content: result.content, totalLines: result.totalLines, truncated: result.truncated, success: true })
        } catch (err) {
          results.push({ path: filePath, error: (err as Error).message, success: false })
        }
      }
      return { files: results }
    }

    case "write_file": {
      const writeResult = await writeFileTool(args.path as string, args.content as string, runId)
      const writeReturn: Record<string, unknown> = {
        path: args.path,
        success: true,
        diffAdded: writeResult.diff?.added || 0,
        diffRemoved: writeResult.diff?.removed || 0
      }

      // Per-file lint check
      const writeLint = await lintFile(args.path as string, process.cwd())
      if (!writeLint.passed) {
        const lintMessages = displayLintErrors([writeLint])
        writeReturn.lint = { passed: false, errors: lintMessages.slice(0, 10) }
      }

      return writeReturn
    }

    case "edit_file": {
      const editResult = await editFileTool({
        path: args.path as string,
        search: args.search as string | undefined,
        replace: args.replace as string | undefined,
        line_start: args.line_start as number | undefined,
        line_end: args.line_end as number | undefined,
        insert_at: args.insert_at as number | undefined,
        content: args.content as string | undefined,
        patch: args.patch as string | undefined,
      }, runId)
      if (!editResult.success) {
        return { path: args.path, success: false, error: editResult.error }
      }
      const editReturn: Record<string, unknown> = {
        path: args.path,
        success: true,
        diffAdded: editResult.diff?.added || 0,
        diffRemoved: editResult.diff?.removed || 0
      }

      // Per-file lint check
      const editLint = await lintFile(args.path as string, process.cwd())
      if (!editLint.passed) {
        const lintMessages = displayLintErrors([editLint])
        editReturn.lint = { passed: false, errors: lintMessages.slice(0, 10) }
      }

      return editReturn
    }

    case "move_file": {
      await moveFileTool(args.from as string, args.to as string)
      return { from: args.from, to: args.to, success: true }
    }

    case "delete_file": {
      await deleteFileTool(args.path as string)
      return { path: args.path, success: true }
    }

    case "search_code": {
      const matches = await searchCodeTool((args.directory as string) || ".", args.pattern as string)
      return { directory: args.directory || ".", pattern: args.pattern, matches }
    }

    case "search_files": {
      const results = await searchFilesTool(
        (args.query as string) || "",
        args.glob as string | undefined
      )
      return { query: args.query, glob: args.glob, results }
    }

    case "run_command": {
      const cmd = (args.command as string) || ""
      if (!cmd) {
        return { error: `run_command requires a "command" argument but received undefined.`, success: false }
      }
      const cmdCwd = (args.cwd as string) || process.cwd()
      // Phase 7: thread runId + background flag through so install commands can background.
      const background = typeof args.background === "boolean" ? args.background : undefined
      const output = await runCommandTool(cmd, cmdCwd, { runId, background, label: cmd.slice(0, 60) })

      // Post-scaffold verification: if command timed out or was interactive,
      // check if the expected output directory was created
      if (output.timedOut || output.interactive) {
        const dirMatch = cmd.match(/(?:new|create-?\S*@?\S*)\s+(\S+)/)
        if (dirMatch) {
          const expectedDir = dirMatch[1]
          const dirPath = path.resolve(cmdCwd, expectedDir)
          try {
            await fs.access(dirPath)
            const entries = await fs.readdir(dirPath)
            if (entries.length > 0) {
              output.message = (output.message || "") + `\n✓ Verified: directory "${expectedDir}" exists with ${entries.length} files. Scaffolding succeeded.`
              output.verified = true
            }
          } catch {
            output.message = (output.message || "") + `\n⚠ Directory "${expectedDir}" was NOT created. Scaffolding may have failed.`
            output.verified = false
          }
        }
      }

      return { command: args.command, cwd: cmdCwd, ...output }
    }

    case "web_search": {
      const results = await webSearchTool(args.query as string)
      // Stage 2 of agent-runtime-fixes plan: tag 0-hit responses so the
      // server-side error path classifies them as a recovery situation
      // rather than a success the agent should consume verbatim.
      // Closes bug 4 (agent halts when search returns nothing because the
      // 'result' was technically valid but carried no signal).
      if (Array.isArray(results) && results.length === 0) {
        return {
          query: args.query,
          results: [],
          success: false,
          error: `Web search returned 0 hits for "${args.query}". This usually means the query is too specific, the documentation doesn't exist at that exact phrasing, or the query references a non-existent file. Do NOT retry the same query. Either reformulate broadly, or skip the search and proceed with best-practice defaults.`,
          _errorCategory: "web_search_empty",
        }
      }
      return { query: args.query, results }
    }

    // ─── Hallucinated tool recovery: batch_write → multiple write_file ───
    case "batch_write": {
      const files = (args.files || []) as Array<{ path: string; content: string }>
      const results: Array<{ path: string; success: boolean; error?: string }> = []
      for (const file of files) {
        try {
          await writeFileTool(file.path, file.content)
          results.push({ path: file.path, success: true })
        } catch (err) {
          results.push({ path: file.path, success: false, error: (err as Error).message })
        }
      }
      return { files: results, totalWritten: results.filter((r) => r.success).length }
    }

    default: {
      // Stage 1 of server-hardening plan: use the canonical
      // KNOWN_TOOL_NAMES set from tool-meta.ts so this list stays
      // in sync with the registry automatically.
      const validList = Array.from(KNOWN_TOOL_NAMES).join(", ")
      return {
        error: `Unknown tool: "${tool}". This tool does not exist. Valid tools are: ${validList}. Use one of these instead.`,
        success: false,
        _errorCategory: "unknown_tool",
        rejectedTool: tool,
      }
    }
  }
}

// ─── Stage 5 of server-hardening plan: per-run telemetry counter ───
//
// Bumped each time the cli's `isKnownTool` gate rejects a tool name
// (either single-tool dispatch or per-tool in a batch). Read by
// `agent.ts: runAgent` at terminal exit + reset via
// `resetNullToolRejections` for the next run. Sustained nonzero
// values mean the model is hallucinating tool names — signal to
// tighten the tool-list section of the system prompt.

let _nullToolRejectionsThisRun = 0

export function getNullToolRejections(): number {
  return _nullToolRejectionsThisRun
}

export function resetNullToolRejections(): void {
  _nullToolRejectionsThisRun = 0
}

function bumpNullToolRejections(): void {
  _nullToolRejectionsThisRun += 1
}

// ─── Stage 5 of code-correctness plan: stripped-imports counter ───
//
// Bumped each time a writeFileTool / editFileTool result carries a
// non-empty `_strippedImports` array (from Stage 2's loud-sanitizer
// path). Counts EVERY stripped import — a single broken file with
// 5 bad imports bumps by 5. Spike on the per-run total = the model
// is writing forward references regularly = tighten Stage 1's
// Node-ESM rules or batching/ordering (Plan 4 covers ordering).

let _importsStrippedThisRun = 0

export function getImportsStrippedCount(): number {
  return _importsStrippedThisRun
}

export function resetImportsStrippedCount(): void {
  _importsStrippedThisRun = 0
}

function bumpImportsStrippedCount(n: number): void {
  if (n > 0) _importsStrippedThisRun += n
}

/** Pure: count stripped imports in a tool result. Exported for tests. */
export function countStrippedInResult(result: Record<string, unknown> | undefined): number {
  if (!result) return 0
  const arr = result._strippedImports
  if (!Array.isArray(arr)) return 0
  return arr.filter((s) => typeof s === "string" && s.length > 0).length
}

/**
 * Stage 1 of plan 2026-05-16-server-hardening-and-error-source-distinction.md.
 *
 * Pre-dispatch gate: rejects tool calls with null / empty / unknown
 * names BEFORE they reach the server, so the server's persist path
 * never sees a row with a null `tool` column. The DB schema enforces
 * `tool TEXT NOT NULL` — without this gate the executor would dispatch
 * `▸ unknown {}`, the server would crash with a Postgres constraint
 * violation, and the cli would surface a raw 500 to the user.
 *
 * Returns a synthetic `validation_failure` result the cli can return
 * to the agent so the next turn surfaces the issue + lets the model
 * pick a real tool name.
 */
export function buildUnknownToolFailure(toolName: unknown): Record<string, unknown> {
  const validList = Array.from(KNOWN_TOOL_NAMES).slice(0, 16).join(", ")
  const displayName = typeof toolName === "string" && toolName.length > 0 ? toolName : "(null/empty)"
  return {
    success: false,
    error: `⛔ INVALID TOOL: "${displayName}" is not a known tool. Valid tools: ${validList}, .... Pick one of these and retry. Do NOT invent tool names — they crash the server-side persist path.`,
    _errorCategory: "unknown_tool",
    rejectedTool: displayName,
  }
}

// ─── Single tool execution (existing flow — execute + send to server) ───

export async function executeTool(
  response: ToolResponse,
  onPhase?: (label: string) => void
): Promise<Record<string, unknown>> {
  const { tool, args, runId } = response

  // Stage 1 of server-hardening plan: reject unknown / null / empty
  // tool names BEFORE dispatch. Returns the failure synthetically so
  // the agent sees the rejection in its next turn instead of the
  // server crashing on a NOT NULL constraint.
  if (!isKnownTool(tool)) {
    bumpNullToolRejections()
    const toolRaw = tool as unknown
    console.warn(`[executor] BLOCKED unknown tool: "${String(toolRaw)}" — synthesising validation failure`)
    const safeName = typeof toolRaw === "string" && toolRaw.length > 0 ? toolRaw : "(invalid)"
    const result = buildUnknownToolFailure(toolRaw)
    const payload = { type: "tool_result", runId, tool: safeName, result }
    let serverResponse: Record<string, unknown>
    try {
      serverResponse = await callServerStream(payload, onPhase)
    } catch {
      serverResponse = await callServer(payload)
    }
    serverResponse.lastToolResult = result
    return serverResponse
  }

  const result = await executeToolLocally(tool, args, runId)
  const payload = { type: "tool_result", runId, tool, result }

  let serverResponse: Record<string, unknown>
  try {
    serverResponse = await callServerStream(payload, onPhase)
  } catch {
    serverResponse = await callServer(payload)
  }

  // Attach local tool result so CLI can check timedOut, skipped, interactive flags
  serverResponse.lastToolResult = result
  return serverResponse
}

// ─── Batch tool execution (parallel — execute all + send batch to server) ───

function askPrompt(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

function isInteractiveCommand(tc: ToolCallEntry): boolean {
  if (tc.tool !== "run_command") return false
  const cmd = ((tc.args.command as string) || "").trim()
  return INTERACTIVE_PATTERNS.some((p) => p.test(cmd))
}

export async function executeToolsBatch(
  tools: ToolCallEntry[],
  runId: string,
  onPhase?: (label: string) => void
): Promise<Record<string, unknown>> {
  // Stage 1 of server-hardening plan: partition the batch into known
  // and unknown tools. Unknown tools (null / empty / hallucinated
  // names) get synthetic validation_failure results without ever
  // touching the local executor or the server. Closes the bug where
  // the agent emitted ▸ unknown {}, the cli dispatched it, and the
  // server crashed with a Postgres NOT NULL constraint on `tool`.
  const knownTools: ToolCallEntry[] = []
  const rejectedResults: Array<{ id: string; tool: string; result: Record<string, unknown> }> = []
  for (const tc of tools) {
    if (isKnownTool(tc.tool)) {
      knownTools.push(tc)
    } else {
      bumpNullToolRejections()
      const tcToolRaw = tc.tool as unknown
      const display = typeof tcToolRaw === "string" && tcToolRaw.length > 0 ? tcToolRaw : "(invalid)"
      console.warn(`[executor] BLOCKED unknown tool in batch: "${display}" (id: ${tc.id}) — synthesising validation failure`)
      rejectedResults.push({ id: tc.id, tool: display, result: buildUnknownToolFailure(tcToolRaw) })
    }
  }
  if (rejectedResults.length > 0 && knownTools.length === 0) {
    // All tools rejected — send only the synthesised failures so the
    // agent's next turn sees the rejections + can retry with valid
    // tool names. Skips git snapshot + permission flow entirely.
    const payload = {
      type: "tool_result",
      runId,
      tool: rejectedResults[0].tool,
      result: rejectedResults[0].result,
      toolResults: rejectedResults,
    }
    try { return await callServerStream(payload, onPhase) } catch { return callServer(payload) }
  }
  // Mixed batch: continue with the known tools; rejected results merge
  // into allResults at the end so the server sees the full picture.
  tools = knownTools

  // Split via tool-meta: concurrency-safe tools run in parallel; everything
  // else runs sequentially (preserving submission order). Sibling abort lives
  // in the serial loop — if a tool with abortsSiblingsOnError fails, the
  // remaining serial siblings are short-circuited with aborted_by_sibling.
  const { parallel: parallelTools, serial: commandTools } = partitionToolCalls(tools)

  // ─── Git snapshot: create before write/edit batches (only if git repo with commits) ───
  const hasWrites = tools.some((tc) => tc.tool === "write_file" || tc.tool === "edit_file" || tc.tool === "delete_file")
  if (hasWrites) {
    try {
      const snap = await createSnapshot(process.cwd(), runId)
      if (snap) {
        console.log(chalk.hex("#5DADE2")(`    ⊟ snapshot: ${snap.strategy === "tag" ? snap.ref.slice(0, 8) : "stashed"} (${snap.dirtyFiles.length} dirty)`))
      }
    } catch {
      // Snapshot failure is non-blocking
    }
  }

  const allResults: Array<{ id: string; tool: string; result: Record<string, unknown> }> = []

  // Execute non-command tools in parallel (read, write, mkdir, search, etc.)
  if (parallelTools.length > 0) {
    // Tell import sanitizer about all files being written in this batch
    const writePaths = parallelTools
      .filter(tc => tc.tool === "write_file" || tc.tool === "edit_file")
      .map(tc => (tc.args.path as string) || "")
      .filter(Boolean)
    if (writePaths.length > 0) setBatchWritePaths(writePaths)

    // Group same-path edit/write ops so they run sequentially within their
    // group while different-path ops still parallelise. Without this, two
    // edit_file calls targeting the same file race and one of them silently
    // loses its changes.
    const groups = groupForParallelExecution(parallelTools)
    const settledGroups = await Promise.allSettled(
      groups.map(async (group) => {
        const groupResults: Array<{ id: string; tool: string; result: Record<string, unknown> }> = []
        for (const tc of group) {
          const result = await executeToolLocally(tc.tool, tc.args, runId)
          groupResults.push({ id: tc.id, tool: tc.tool, result })
        }
        return groupResults
      })
    )

    // Flatten group results into a flat list, preserving the original tool
    // order via the {id} field that downstream code dedupes / matches on.
    const settled: Array<PromiseSettledResult<{ id: string; tool: string; result: Record<string, unknown> }>> = []
    for (const g of settledGroups) {
      if (g.status === "fulfilled") {
        for (const r of g.value) settled.push({ status: "fulfilled", value: r })
      } else {
        settled.push({ status: "rejected", reason: g.reason })
      }
    }

    if (writePaths.length > 0) clearBatchWritePaths()

    for (let i = 0; i < settled.length; i++) {
      const r = settled[i]
      if (r.status === "fulfilled") {
        allResults.push(r.value)
      } else {
        allResults.push({
          id: parallelTools[i].id,
          tool: parallelTools[i].tool,
          result: { error: (r.reason as Error).message, success: false, path: parallelTools[i].args.path }
        })
      }
    }
  }

  // Execute serial tools one at a time. If any tool with
  // abortsSiblingsOnError fails (currently only run_command), short-circuit
  // the remaining serial tools with an aborted_by_sibling marker.
  let siblingAbortReason: string | null = null
  for (const tc of commandTools) {
    if (siblingAbortReason) {
      allResults.push({
        id: tc.id,
        tool: tc.tool,
        result: {
          aborted_by_sibling: true,
          success: false,
          error: `Aborted because a sibling tool failed: ${siblingAbortReason}`,
        },
      })
      continue
    }

    let cmd = (tc.args.command as string) || tc.tool
    let result: Record<string, unknown> | null = null
    let autoFixAttempted = false
    let webSearchAttempted = false

    while (!result) {
      try {
        const r = await executeToolLocally(tc.tool, tc.args, runId)
        // Check if the command actually failed (non-zero exit)
        if (r.stderr && !r.interactive) {
          throw new Error(r.stderr as string)
        }
        result = r
      } catch (err) {
        const errMsg = (err as Error).message
        cmd = (tc.args.command as string) || cmd

        // ─── Smart recovery chain ───
        const recovery = recoverFromCommandError(cmd, errMsg)

        // Step 1: Auto-fix (known pattern)
        if (recovery.action === "auto_fix" && recovery.fixedCommand && !autoFixAttempted) {
          autoFixAttempted = true
          console.log("")
          console.log(chalk.yellow(`  ⚠ Command failed: `) + chalk.dim(cmd))
          console.log(chalk.cyan(`    ↳ Auto-fix: `) + chalk.dim(recovery.description))
          console.log(chalk.cyan(`    ↳ Trying: `) + chalk.white(recovery.fixedCommand))
          tc.args = { ...tc.args, command: recovery.fixedCommand }
          continue // retry with fixed command
        }

        // Step 2: Skip (known unfixable — e.g., tailwindcss init removed)
        if (recovery.action === "skip") {
          console.log("")
          console.log(chalk.yellow(`  ⚠ Command skipped: `) + chalk.dim(cmd))
          console.log(chalk.dim(`    ${recovery.description}`))
          result = {
            error: `Auto-skipped: ${recovery.description}`,
            success: false,
            skipped: true,
            message: `SKIPPED: ${recovery.description}. Continue creating files with write_file. Do NOT stop.`
          }
          continue
        }

        // Step 3: Web search for unknown errors
        if (recovery.action === "web_search" && !webSearchAttempted) {
          webSearchAttempted = true
          console.log("")
          console.log(chalk.yellow(`  ⚠ Command failed: `) + chalk.dim(cmd))
          console.log(chalk.cyan(`    ↳ Searching web for correct command...`))

          const webFix = await searchForCommandFix(cmd, errMsg)
          if (webFix) {
            console.log(chalk.cyan(`    ↳ Found: `) + chalk.white(webFix))
            console.log(chalk.dim(`    Retrying with web-suggested command...`))
            tc.args = { ...tc.args, command: webFix }
            continue // retry with web-found command
          }
          console.log(chalk.dim(`    ↳ No fix found via web search.`))
        }

        // Step 4: Last resort — ask user
        console.log("")
        console.log(chalk.red(`  ✖ Command failed: `) + chalk.dim(cmd))
        console.log(chalk.dim(`    ${errMsg.slice(0, 200)}`))
        console.log("")
        console.log(chalk.white("  What would you like to do?"))
        console.log(chalk.dim("    r") + " — retry the command")
        console.log(chalk.dim("    s") + " — skip this command and continue")
        console.log(chalk.dim("    m") + " — enter a different command to run instead")
        console.log("")

        const answer = await askPrompt("  > ")

        if (answer === "r" || answer === "retry") {
          autoFixAttempted = false  // allow auto-fix again on retry
          webSearchAttempted = false
          continue // retry same command
        } else if (answer === "s" || answer === "skip") {
          result = { error: `Skipped by user: ${errMsg}`, success: false, skipped: true }
        } else if (answer === "m" || answer === "manual" || answer.length > 3) {
          // If they typed a command directly, use it
          const newCmd = (answer === "m" || answer === "manual")
            ? await askPrompt("  command> ")
            : answer
          if (newCmd) {
            tc.args = { ...tc.args, command: newCmd }
            autoFixAttempted = false
            webSearchAttempted = false
            continue // retry with new command
          } else {
            result = { error: `Skipped by user`, success: false, skipped: true }
          }
        } else {
          result = { error: `Skipped: ${errMsg}`, success: false, skipped: true }
        }
      }
    }

    allResults.push({ id: tc.id, tool: tc.tool, result })

    // If this tool aborts siblings on error and the result is a failure, set
    // the abort flag so subsequent serial siblings short-circuit.
    if (getToolMeta(tc.tool).abortsSiblingsOnError) {
      const failed = result.error || result.success === false || result.skipped === true
      if (failed) {
        siblingAbortReason = (result.error as string) || (result.skipped ? "previous command was skipped" : "previous command failed")
      }
    }
  }

  // Sort results back to original order
  const orderMap = new Map(tools.map((t, i) => [t.id, i]))
  allResults.sort((a, b) => (orderMap.get(a.id) || 0) - (orderMap.get(b.id) || 0))

  // ─── Auto-verification: run after write batches ───
  const writtenFiles = allResults
    .filter((r) => (r.tool === "write_file" || r.tool === "edit_file" || r.tool === "batch_write") && r.result.success !== false)
    .flatMap((r) => {
      if (r.tool === "batch_write" && Array.isArray(r.result.files)) {
        return (r.result.files as Array<{ path: string; success: boolean }>).filter((f) => f.success).map((f) => f.path)
      }
      return [(r.result.path as string) || ""]
    })
    .filter(Boolean)

  // ─── Lint check: run on ALL written files (fast per-file + optional tsc) ───
  if (writtenFiles.length > 0) {
    try {
      resetTscCache() // Force fresh tsc check for batches
      const lintResults = await lintFiles(writtenFiles, process.cwd())
      const failedLints = lintResults.filter(r => !r.passed)

      if (failedLints.length > 0) {
        console.log(chalk.hex("#E74C3C")(`    ── lint: ${failedLints.flatMap(r => r.errors).length} error(s) in ${failedLints.length} file(s) ──`))
        const lintMessages = displayLintErrors(failedLints)

        // Append lint result so the AI sees the errors and can fix them
        allResults.push({
          id: `lint_${allResults.length}`,
          tool: "_lint",
          result: {
            passed: false,
            errors: lintMessages.slice(0, 20),
            fileCount: failedLints.length,
            success: false
          }
        })
      } else {
        console.log(chalk.hex("#58D68D")(`    ── lint: ${writtenFiles.length} file(s) OK ──`))
      }
    } catch {
      // Lint failed to run — don't block the flow
    }
  }

  if (writtenFiles.length >= 3) {
    // Run verification silently — only report if errors found
    try {
      const report = await runVerification(process.cwd(), writtenFiles, runId)
      if (!report.overall) {
        // Append verification result as a synthetic tool result
        allResults.push({
          id: `verify_${allResults.length}`,
          tool: "_verification",
          result: {
            passed: false,
            errors: report.checks.flatMap((c) => c.errors).slice(0, 15),
            warnings: report.checks.flatMap((c) => c.warnings).slice(0, 5),
            summary: report.summary,
            success: false
          }
        })

        // ─── Offer rollback if git snapshot exists and verification failed badly ───
        const snap = getSnapshot(runId)
        const errorCount = report.checks.flatMap((c) => c.errors).length
        if (snap && errorCount >= 5) {
          console.log("")
          console.log(chalk.hex("#E74C3C")(`    ⚠ Verification found ${errorCount} errors`))
          console.log(chalk.hex("#7F8C8D")(`    Snapshot available: ${snap.id.slice(0, 20)}`))
          console.log(chalk.hex("#7F8C8D")(`    Press 'r' to rollback, or Enter to let AI fix`))
          const answer = await askPrompt("    > ")
          if (answer.toLowerCase() === "r" || answer.toLowerCase() === "rollback") {
            const success = await rollback(process.cwd(), runId)
            if (success) {
              console.log(chalk.hex("#58D68D")("    ✓ Rolled back to snapshot"))
              allResults.push({
                id: `rollback_${allResults.length}`,
                tool: "_rollback",
                result: {
                  rolledBack: true,
                  message: "User rolled back changes due to verification errors. All writes from this batch were reverted. Try a different approach.",
                  success: false
                }
              })
            } else {
              console.log(chalk.hex("#E74C3C")("    ✗ Rollback failed — continuing normally"))
            }
          }
        }
      } else {
        // Verification passed — clean up the snapshot
        cleanupSnapshot(process.cwd(), runId).catch(() => {})
      }
    } catch {
      // Verification failed to run — don't block the flow
    }
  } else if (hasWrites) {
    // Small batch, no verification — clean up snapshot silently
    cleanupSnapshot(process.cwd(), runId).catch(() => {})
  }

  // ─── Stage 4 of agent-runtime-fixes plan: per-turn directory refresh ───
  // If this batch contained any MUTATING tool (write / edit / delete /
  // create_directory / batch_write / run_command), snapshot the top-level
  // directory tree NOW and attach it to the tool_result payload. The
  // server-side context-manager compares it against the working
  // context's file map and injects a "DIRECTORY STATE CHANGED" reminder
  // when previously-tracked top-level files no longer exist. Closes bug
  // 5 (stale file references / hallucination).
  const MUTATING_TOOLS = new Set(["write_file", "edit_file", "delete_file", "create_directory", "batch_write", "move_file", "run_command"])
  const batchMutated = tools.some((tc) => MUTATING_TOOLS.has(tc.tool))
  let refreshedTree: Array<{ name: string; type: "file" | "directory" }> | undefined
  if (batchMutated) {
    refreshedTree = await captureTopLevelTree(process.cwd())
  }

  // Stage 1 of server-hardening plan: merge any rejected (unknown-tool)
  // synthetic results into the batch's allResults so the server's
  // tool_result handler sees the full picture — including which tools
  // were rejected so the agent gets feedback on its next turn.
  const mergedResults = [...allResults, ...rejectedResults]
  const payload = {
    type: "tool_result",
    runId,
    tool: mergedResults[0]?.tool || tools[0].tool,      // backwards compat
    result: mergedResults[0]?.result || {},
    toolResults: mergedResults,
    directoryTree: refreshedTree,
  }

  // Try streaming first, fall back to batch
  try {
    return await callServerStream(payload, onPhase)
  } catch {
    return callServer(payload)
  }
}

/**
 * Stage 1 of awareness-and-verification-correctness plan: top-level
 * entries treated as noise. Heavy build dirs + tooling caches + the
 * git workdir + the sysbase prefix — everything the agent never
 * authors or reads at the top level.
 *
 * DELIBERATELY EXCLUDES legitimate top-level dotfiles (.env,
 * .env.example, .gitignore, .eslintrc.json, .npmrc, .prettierrc,
 * .editorconfig, .nvmrc, .dockerignore) — the agent commonly
 * authors these and the user expects them in the tree. The prior
 * "strip all .*" filter false-flagged .env.example as stale because
 * the cli stripped it from the tree, the server still tracked it
 * in ctx.files from the just-completed write, and the staleness
 * comparison reported "stale top-level files: .env.example".
 *
 * Kept in sync with server/src/services/context-manager.ts —
 * NOISE_TOP_LEVEL_ENTRIES. Both sides MUST agree on what counts
 * as noise; otherwise staleness detection desyncs again.
 */
export const NOISE_TOP_LEVEL_ENTRIES: ReadonlySet<string> = new Set([
  ".git",
  ".DS_Store",
  ".vscode",
  ".idea",
  "node_modules",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".next",
  ".nuxt",
  "dist",
  "build",
  ".turbo",
  ".cache",
])

export function isNoiseTopLevelEntry(name: string): boolean {
  if (NOISE_TOP_LEVEL_ENTRIES.has(name)) return true
  if (name.startsWith("sysbase")) return true
  return false
}

/**
 * Stage 4 of agent-runtime-fixes plan (filter refined by Stage 1 of
 * awareness-and-verification-correctness plan): top-level directory
 * snapshot used by the per-turn refresh path. Cheap — single readdir,
 * no recursion. Best-effort: returns undefined on I/O error so the
 * caller drops the field (server falls back to the prior tree).
 *
 * Filter is now conservative — keeps legitimate dotfiles
 * (.env*, .gitignore, .eslintrc*, .npmrc, etc.); drops only the
 * heavy/noise set in NOISE_TOP_LEVEL_ENTRIES.
 */
async function captureTopLevelTree(cwd: string): Promise<Array<{ name: string; type: "file" | "directory" }> | undefined> {
  try {
    const entries = await fs.readdir(cwd, { withFileTypes: true })
    return entries
      .filter((e) => !isNoiseTopLevelEntry(e.name))
      .map((e) => ({ name: e.name, type: e.isDirectory() ? ("directory" as const) : ("file" as const) }))
  } catch {
    return undefined
  }
}
