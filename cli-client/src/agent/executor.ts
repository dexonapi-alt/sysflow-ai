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

export async function executeToolLocally(tool: string, args: Record<string, unknown>, runId?: string): Promise<Record<string, unknown>> {
  // ─── Arg validation: catch undefined/null args before they cause cryptic errors ───
  if (!args) args = {}

  // Tools that require a 'path' arg
  if (["list_directory", "file_exists", "create_directory", "read_file", "write_file", "edit_file", "delete_file"].includes(tool)) {
    if (!args.path && tool !== "write_file" && tool !== "edit_file") {
      return { error: `Tool "${tool}" requires a "path" argument but received undefined. Check args.`, success: false }
    }
  }

  // write_file/edit_file need both path and content
  if (tool === "write_file" && (!args.path || !args.content)) {
    return { error: `write_file requires "path" and "content" args. Got path=${args.path}, content=${args.content ? "present" : "missing"}`, success: false }
  }
  if (tool === "edit_file" && !args.path) {
    return { error: `edit_file requires "path" arg. Got path=${args.path}`, success: false }
  }
  if (tool === "edit_file" && !args.search && !args.line_start && !args.insert_at && !args.patch && !args.content) {
    return { error: `edit_file requires one of: search+replace, line_start+content, insert_at+content, patch, or content. None provided.`, success: false }
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
      const output = await runCommandTool(cmd, cmdCwd)

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
      const KNOWN_TOOLS = [
        "list_directory", "read_file", "batch_read", "write_file",
        "edit_file", "create_directory", "search_code", "search_files",
        "run_command", "move_file", "delete_file", "web_search",
        "file_exists", "batch_write"
      ]
      return {
        error: `Unknown tool: "${tool}". This tool does not exist. Valid tools are: ${KNOWN_TOOLS.join(", ")}. Use one of these instead.`,
        success: false,
        rejectedTool: tool
      }
    }
  }
}

// ─── Single tool execution (existing flow — execute + send to server) ───

export async function executeTool(
  response: ToolResponse,
  onPhase?: (label: string) => void
): Promise<Record<string, unknown>> {
  const { tool, args, runId } = response
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
  // Split: run_command tools run sequentially, everything else in parallel
  const parallelTools = tools.filter((tc) => tc.tool !== "run_command")
  const commandTools = tools.filter((tc) => tc.tool === "run_command")

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

    const settled = await Promise.allSettled(
      parallelTools.map(async (tc) => {
        const result = await executeToolLocally(tc.tool, tc.args, runId)
        return { id: tc.id, tool: tc.tool, result }
      })
    )

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

  // Execute ALL command tools one at a time (they share shell/stdin and may depend on each other)
  for (const tc of commandTools) {
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

  const payload = {
    type: "tool_result",
    runId,
    tool: tools[0].tool,      // backwards compat
    result: allResults[0]?.result || {},
    toolResults: allResults
  }

  // Try streaming first, fall back to batch
  try {
    return await callServerStream(payload, onPhase)
  } catch {
    return callServer(payload)
  }
}
