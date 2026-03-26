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
  INTERACTIVE_PATTERNS
} from "./tools.js"

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

export async function executeToolLocally(tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
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
      const content = await readFileTool(args.path as string)
      return { path: args.path, content }
    }

    case "batch_read": {
      const results: Array<{ path: string; content?: string; error?: string; success: boolean }> = []
      for (const filePath of args.paths as string[]) {
        try {
          const content = await readFileTool(filePath)
          results.push({ path: filePath, content, success: true })
        } catch (err) {
          results.push({ path: filePath, error: (err as Error).message, success: false })
        }
      }
      return { files: results }
    }

    case "write_file": {
      await writeFileTool(args.path as string, args.content as string)
      return { path: args.path, success: true }
    }

    case "edit_file": {
      await editFileTool(args.path as string, args.patch as string)
      return { path: args.path, success: true }
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
      const output = await runCommandTool(args.command as string, (args.cwd as string) || process.cwd())
      return { command: args.command, cwd: args.cwd || process.cwd(), ...output }
    }

    case "web_search": {
      const results = await webSearchTool(args.query as string)
      return { query: args.query, results }
    }

    default:
      throw new Error(`Unknown tool: ${tool}`)
  }
}

// ─── Single tool execution (existing flow — execute + send to server) ───

export async function executeTool(
  response: ToolResponse,
  onPhase?: (label: string) => void
): Promise<Record<string, unknown>> {
  const { tool, args, runId } = response
  const result = await executeToolLocally(tool, args)
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

  const allResults: Array<{ id: string; tool: string; result: Record<string, unknown> }> = []

  // Execute non-command tools in parallel (read, write, mkdir, search, etc.)
  if (parallelTools.length > 0) {
    const settled = await Promise.allSettled(
      parallelTools.map(async (tc) => {
        const result = await executeToolLocally(tc.tool, tc.args)
        return { id: tc.id, tool: tc.tool, result }
      })
    )

    for (let i = 0; i < settled.length; i++) {
      const r = settled[i]
      if (r.status === "fulfilled") {
        allResults.push(r.value)
      } else {
        allResults.push({
          id: parallelTools[i].id,
          tool: parallelTools[i].tool,
          result: { error: (r.reason as Error).message, success: false }
        })
      }
    }
  }

  // Execute ALL command tools one at a time (they share shell/stdin and may depend on each other)
  for (const tc of commandTools) {
    const cmd = (tc.args.command as string) || tc.tool
    let result: Record<string, unknown> | null = null

    while (!result) {
      try {
        const r = await executeToolLocally(tc.tool, tc.args)
        // Check if the command actually failed (non-zero exit)
        if (r.stderr && !r.interactive) {
          throw new Error(r.stderr as string)
        }
        result = r
      } catch (err) {
        const errMsg = (err as Error).message
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
