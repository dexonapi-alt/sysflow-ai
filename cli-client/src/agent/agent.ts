import os from "node:os"
import path from "node:path"
import chalk from "chalk"
import ora from "ora"
import { callServer } from "../lib/server.js"
import { ensureSysbase, getSelectedModel, getSysbasePath, getReasoningEnabled, getAuthToken } from "../lib/sysbase.js"
import { executeTool, executeToolsBatch } from "./executor.js"
import { readFileTool, computeLineDiff } from "./tools.js"
import { getOrBuildIndex, compactTree } from "./indexer.js"
import { ensureActiveChat } from "../commands/chats.js"

interface ServerError extends Error {
  code?: string
  plan?: string
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ─── Color palette ───

const colors = {
  accent: chalk.hex("#7C6FFF"),       // purple accent
  accentDim: chalk.hex("#5A50B8"),    // muted purple
  success: chalk.hex("#58D68D"),      // green
  warning: chalk.hex("#F4D03F"),      // yellow
  error: chalk.hex("#E74C3C"),        // red
  info: chalk.hex("#5DADE2"),         // blue
  muted: chalk.hex("#7F8C8D"),       // gray
  bright: chalk.hex("#ECF0F1"),      // off-white
  tool: chalk.hex("#48C9B0"),        // teal for tool names
  file: chalk.hex("#AEB6BF"),        // silver for paths
  bar: chalk.hex("#34495E"),         // dark bar color
}

// ─── Box drawing helpers ───

const BOX = {
  tl: "╭", tr: "╮", bl: "╰", br: "╯",
  h: "─", v: "│",
  lt: "├", rt: "┤",
  dot: "●", ring: "○", arrow: "▸", check: "✔", cross: "✖", dash: "─",
} as const

function boxLine(width: number): string {
  return colors.bar(BOX.h.repeat(width))
}

function boxTop(label: string, width = 40): string {
  const inner = ` ${label} `
  const pad = Math.max(0, width - inner.length - 2)
  return colors.bar(BOX.tl + BOX.h) + colors.accent.bold(inner) + colors.bar(BOX.h.repeat(pad) + BOX.tr)
}

function boxMid(content: string, width = 40): string {
  return colors.bar(BOX.v) + " " + content
}

function boxBot(width = 40): string {
  return colors.bar(BOX.bl + BOX.h.repeat(width) + BOX.br)
}

// ─── Reasoning: instant display with sweep reveal animation ───

async function revealReasoning(text: string): Promise<void> {
  const lines = text.split("\n")
  const allLines: string[] = []

  for (const line of lines) {
    allLines.push(`    ${colors.muted(BOX.v)} ${colors.muted(line)}`)
  }

  // Print all lines instantly but dim
  const totalLines = allLines.length
  for (const line of allLines) {
    process.stdout.write(chalk.dim(line) + "\n")
  }

  // Sweep animation: re-render each line brighter with a short cascade delay
  if (totalLines > 0 && totalLines <= 20) {
    // Move cursor back up
    process.stdout.write(`\x1b[${totalLines}A`)
    for (let i = 0; i < totalLines; i++) {
      process.stdout.write("\r\x1b[K") // clear line
      process.stdout.write(allLines[i] + "\n")
      await sleep(25 + Math.floor(Math.random() * 15))
    }
  }
  await sleep(80)
}

// ─── Tool label formatting ───

function formatToolLabel(tool: string, args: Record<string, unknown>): string | null {
  switch (tool) {
    case "read_file":
      return colors.tool("read") + " " + colors.file(args.path as string)
    case "batch_read":
      return null
    case "write_file":
      return colors.tool("create") + " " + colors.file(args.path as string)
    case "edit_file":
      return colors.tool("edit") + " " + colors.file(args.path as string)
    case "create_directory":
      return colors.tool("mkdir") + " " + colors.file(args.path as string)
    case "move_file":
      return colors.tool("move") + " " + colors.file(args.from as string) + colors.muted(" → ") + colors.file(args.to as string)
    case "delete_file":
      return colors.tool("delete") + " " + colors.file(args.path as string)
    case "file_exists":
      return colors.tool("check") + " " + colors.file(args.path as string)
    case "search_code":
      return colors.tool("search") + " " + colors.bright(`"${args.pattern}"`)
    case "search_files":
      return colors.tool("find") + " " + colors.bright(`"${args.query || args.glob}"`)
    case "run_command":
      return colors.tool("run") + " " + colors.bright(args.command as string)
    default:
      return colors.tool(tool) + " " + colors.muted(JSON.stringify(args))
  }
}

function isHiddenStep(tool: string): boolean {
  return tool === "list_directory"
}

// ─── Step icon helpers ───

function stepIcon(status: string | undefined): string {
  if (status === "completed") return colors.success(BOX.check)
  if (status === "in_progress") return colors.accent(BOX.arrow)
  return colors.muted(BOX.ring)
}

function stepLabel(label: string, status: string | undefined): string {
  if (status === "completed") return colors.success(label)
  if (status === "in_progress") return colors.accent.bold(label)
  return colors.muted(label)
}

function resolveFileMentions(prompt: string, cwd: string): { prompt: string; mentions: Array<{ path: string; absolute: string }> } {
  const mentions: Array<{ path: string; absolute: string }> = []
  const resolved = prompt.replace(/@([\w./-]+)/g, (_match, filePath: string) => {
    const absolute = path.resolve(cwd, filePath)
    mentions.push({ path: filePath, absolute })
    return filePath
  })
  return { prompt: resolved, mentions }
}

interface RunAgentParams {
  prompt: string
  command?: string | null
  model?: string | null
}

export async function runAgent({ prompt, command = null, model = null }: RunAgentParams): Promise<Record<string, unknown> | undefined> {
  await ensureSysbase()

  const authToken = await getAuthToken()
  if (!authToken) {
    console.log("")
    console.log(colors.warning("  ⚠ You must be logged in to use Sysflow"))
    console.log("")
    console.log(colors.muted("  Run ") + colors.accent("sys login") + colors.muted(" or ") + colors.accent("sys register") + colors.muted(" to get started"))
    console.log("")
    return
  }

  const selectedModel = model || (await getSelectedModel())
  const hasReasoning = await getReasoningEnabled()

  const chatUid = await ensureActiveChat()
  if (!chatUid) {
    console.log("")
    console.log(colors.warning("  ⚠ Could not establish a chat session"))
    console.log(colors.muted("  Check your connection and try again, or run ") + colors.accent("sys chat") + colors.muted(" to select one"))
    console.log("")
    return
  }

  const { prompt: cleanPrompt, mentions } = resolveFileMentions(prompt, process.cwd())

  const mentionedFiles: Array<{ path: string; content: string }> = []
  for (const m of mentions) {
    try {
      const content = await readFileTool(m.absolute)
      mentionedFiles.push({ path: m.path, content })
    } catch {
      // file doesn't exist, skip
    }
  }

  const fileIndex = await getOrBuildIndex(process.cwd(), getSysbasePath())
  const dirTree = compactTree(fileIndex)

  console.log("")

  const spinner = ora({
    text: colors.muted("thinking..."),
    prefixText: "  ",
    spinner: "dots",
    color: "magenta"
  }).start()

  let response: Record<string, unknown>
  try {
    response = await callServer({
      type: "user_message",
      command,
      content: cleanPrompt,
      model: selectedModel,
      projectId: path.basename(process.cwd()),
      cwd: process.cwd(),
      sysbasePath: getSysbasePath(),
      directoryTree: dirTree,
      mentionedFiles,
      chatUid: chatUid || undefined,
      client: { platform: os.platform(), arch: os.arch() }
    })
  } catch (err) {
    spinner.stop()
    if ((err as ServerError).code === "USAGE_LIMIT") {
      console.log("")
      console.log(colors.warning("  ⚠ " + (err as Error).message))
      console.log("")
      console.log(colors.muted("  Run ") + colors.accent("sys billing") + colors.muted(" to upgrade your plan"))
      console.log("")
      return
    }
    throw err
  }

  let stepCount = 0
  let taskShown = false
  let taskSteps: Array<{ id: string; label: string; status?: string }> = []
  const completedSteps = new Set<string>()
  let consecutiveErrors = 0
  const MAX_CONSECUTIVE_ERRORS = 3
  let lastDisplayedAction: string | null = null

  while (true) {
    switch (response.status) {
      case "completed": {
        spinner.stop()

        if (hasReasoning && response.reasoning) {
          await revealReasoning(response.reasoning as string)
        }

        console.log("")

        const summary = response.summary as Record<string, unknown> | null
        if (summary && summary.memoryUpdated) {
          console.log("  " + boxTop("MEMORY", 36))
          if (summary.patternSaved) {
            console.log("  " + boxMid(colors.bright(`Pattern: ${summary.patternSaved}`)))
          }
          console.log("  " + boxMid(colors.muted("Shared with the whole team.")))
          console.log("  " + boxBot(36))
          console.log("")
        }

        if (taskSteps.length > 0) {
          console.log("  " + boxTop(`${completedSteps.size}/${taskSteps.length} COMPLETE`, 36))
          for (const s of taskSteps) {
            const done = completedSteps.has(s.id)
            console.log("  " + boxMid(`${done ? stepIcon("completed") : stepIcon(undefined)} ${done ? stepLabel(s.label, "completed") : stepLabel(s.label, undefined)}`))
          }
          console.log("  " + boxBot(36))
          console.log("")
        }

        // Animated completion line
        const doneText = `  ${colors.success(BOX.check)} done`
        const stepText = colors.muted(` ${BOX.dash} ${stepCount} steps`)
        process.stdout.write(doneText)
        await sleep(60)
        console.log(stepText)
        console.log("")
        return response
      }

      case "waiting_for_user":
        spinner.stop()
        console.log("")
        console.log(colors.warning(`  ${BOX.ring} paused: ${response.message || "Waiting for user"}`))
        console.log("")
        return response

      case "failed": {
        if (stepCount > 0 && consecutiveErrors < MAX_CONSECUTIVE_ERRORS && response.runId) {
          consecutiveErrors++
          spinner.stop()
          console.log(colors.error(`  ${BOX.cross} ${response.error || "Model reported failure"}`))
          spinner.start(colors.muted("retrying..."))
          response = await callServer({
            type: "tool_result",
            runId: response.runId,
            tool: "_recovery",
            result: {
              error: response.error || "Previous step failed",
              success: false,
              hint: "Please fix the issue and continue. Do NOT give up. Respond with needs_tool to take the next action."
            }
          })
          break
        }
        spinner.fail(colors.error((response.error as string) || "Agent failed"))
        throw new Error((response.error as string) || "Agent failed")
      }

      case "needs_tool": {
        stepCount++

        // Handle step transitions from AI
        const stepTransition = response.stepTransition as { complete?: string; start?: string } | undefined
        if (stepTransition) {
          if (stepTransition.complete) {
            completedSteps.add(stepTransition.complete)
          }
        }

        const toolCalls = response.tools as Array<{ id: string; tool: string; args: Record<string, unknown> }> | undefined
        const isParallel = toolCalls && toolCalls.length > 1

        // Show task on first tool call
        const task = response.task as Record<string, unknown> | null
        if (task && !taskShown) {
          spinner.stop()
          taskShown = true
          taskSteps = (task.steps || []) as Array<{ id: string; label: string; status?: string }>

          console.log("")
          console.log("  " + boxTop("TASK", 42))
          console.log("  " + boxMid(colors.bright.bold(task.title as string)))
          console.log("  " + boxMid(colors.muted(task.goal as string)))
          console.log("  " + boxMid(""))

          for (let i = 0; i < taskSteps.length; i++) {
            const s = taskSteps[i]
            console.log("  " + boxMid(`${stepIcon(s.status)} ${stepLabel(s.label, s.status)}`))
          }
          console.log("  " + boxBot(42))
          console.log("")

          spinner.start(colors.muted("thinking..."))
        }

        // Update step display from task in response
        if (task?.steps) {
          const steps = task.steps as Array<{ id: string; status?: string }>
          for (const s of steps) {
            if (s.status === "completed" && s.id) completedSteps.add(s.id)
          }
        }

        if (isParallel) {
          // ═══ PARALLEL EXECUTION PATH ═══
          spinner.stop()

          if (hasReasoning && response.reasoning) {
            await revealReasoning(response.reasoning as string)
          }

          // Animated parallel header
          console.log("")
          console.log(colors.accent(`    ${BOX.tl}${BOX.h}${BOX.h} parallel `) + colors.muted(`(${toolCalls!.length} tools)`))

          // List tools with staggered reveal
          for (let i = 0; i < toolCalls!.length; i++) {
            const tc = toolCalls![i]
            const label = formatToolLabel(tc.tool, tc.args)
            await sleep(40)
            console.log(colors.accent(`    ${BOX.v}`) + `  ${colors.muted(BOX.ring)} ` + (label || `${tc.tool} ${JSON.stringify(tc.args)}`))
          }

          spinner.start(colors.muted(`  executing ${toolCalls!.length} tools...`))

          try {
            response = await executeToolsBatch(toolCalls!, response.runId as string)
            consecutiveErrors = 0
            spinner.stop()

            // Animated completion: mark each tool done
            process.stdout.write(`\x1b[${toolCalls!.length}A`)
            for (let i = 0; i < toolCalls!.length; i++) {
              const tc = toolCalls![i]
              const label = formatToolLabel(tc.tool, tc.args)
              process.stdout.write("\r\x1b[K")
              console.log(colors.accent(`    ${BOX.v}`) + `  ${colors.success(BOX.check)} ` + (label || `${tc.tool}`))
              await sleep(50)
            }

            console.log(colors.accent(`    ${BOX.bl}${BOX.h}${BOX.h}`) + ` ${colors.success("done")}`)
            console.log("")
            spinner.start(colors.muted("thinking..."))
          } catch (batchError) {
            consecutiveErrors++
            spinner.stop()
            console.log(colors.accent(`    ${BOX.bl}${BOX.h}${BOX.h}`) + ` ${colors.error("error:")} ` + colors.muted((batchError as Error).message))

            if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
              console.log(colors.error(`\n  aborted: ${MAX_CONSECUTIVE_ERRORS} consecutive errors`))
              throw new Error("Too many consecutive tool errors")
            }

            spinner.start(colors.muted("thinking..."))
            response = await callServer({
              type: "tool_result",
              runId: response.runId,
              tool: "_recovery",
              result: { error: (batchError as Error).message, success: false }
            })
          }
          break
        }

        // ═══ SINGLE TOOL PATH ═══
        const pendingTaskStep = (response.taskStep as string) || null
        const args = response.args as Record<string, unknown>

        const actionKey = `${response.tool}:${JSON.stringify(args)}:${response.reasoning || ""}`
        const isDuplicate = actionKey === lastDisplayedAction
        lastDisplayedAction = actionKey

        await sleep(hasReasoning ? 200 : 100 + Math.floor(Math.random() * 150))

        if (isHiddenStep(response.tool as string)) {
          spinner.text = colors.muted("scanning directory...")
        } else if (isDuplicate) {
          spinner.stop()
          spinner.start(colors.muted("thinking..."))
        } else {
          if (hasReasoning && response.reasoning) {
            spinner.stop()
            await revealReasoning(response.reasoning as string)
          } else {
            spinner.stop()
          }

          if (response.tool === "batch_read") {
            const paths = (args.paths || []) as string[]
            console.log(`    ${colors.tool("read")} ${colors.muted(`${paths.length} files`)}`)
            for (const p of paths) {
              console.log(colors.muted(`      ${BOX.dot} ${p}`))
            }
          } else if (response.tool === "run_command") {
            const cmd = args.command as string
            spinner.start(colors.muted("  ") + colors.bright(cmd))
          } else {
            const label = formatToolLabel(response.tool as string, args)
            const hasDiff = response.tool === "write_file" || response.tool === "edit_file"
            if (hasDiff) {
              const newContent = (args.content || args.patch || "") as string
              let oldContent: string | null = null
              try { oldContent = await readFileTool(args.path as string) } catch { /* new file */ }
              const { added, removed } = computeLineDiff(oldContent, newContent)
              const parts: string[] = []
              if (added > 0) parts.push(colors.success(`+${added}`))
              if (removed > 0) parts.push(colors.error(`-${removed}`))
              const diffTag = parts.length > 0 ? " " + parts.join(colors.muted(" ")) : ""
              console.log(`    ${colors.accent(BOX.arrow)} ${label}${diffTag}`)
            } else {
              console.log(`    ${colors.accent(BOX.arrow)} ${label}`)
            }
          }

          if (response.tool !== "run_command") {
            spinner.start(colors.muted("thinking..."))
          }
        }

        const currentTool = response.tool as string
        const currentCmd = args?.command as string | undefined

        try {
          response = await executeTool(response as never)
          consecutiveErrors = 0

          if (currentTool === "run_command") {
            spinner.stop()
            const toolResult = (response.result || response.lastResult) as Record<string, unknown> | undefined
            if (toolResult?.skipped) {
              console.log(colors.warning(`  ⚠ `) + colors.muted(currentCmd) + colors.warning(" (run manually)"))
            } else if (toolResult?.timedOut) {
              console.log(colors.warning(`  ⏱ `) + colors.muted(currentCmd) + colors.warning(" (timed out)"))
            } else {
              console.log(`  ${colors.success(BOX.check)} ` + colors.muted(currentCmd))
            }
            spinner.start(colors.muted("thinking..."))
          }

          if (pendingTaskStep && taskSteps.length > 0) {
            const step = taskSteps.find((s) => s.id === pendingTaskStep)
            if (step) completedSteps.add(step.id)
          }
        } catch (toolError) {
          consecutiveErrors++
          spinner.stop()
          if (currentTool === "run_command") {
            console.log(colors.error(`  ${BOX.cross} `) + colors.muted(currentCmd) + colors.error(` — ${(toolError as Error).message}`))
          } else {
            console.log(colors.error(`    ${BOX.cross} ${(toolError as Error).message}`))
          }

          if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            console.log(colors.error(`\n  aborted: ${MAX_CONSECUTIVE_ERRORS} consecutive errors`))
            console.log("")
            throw new Error("Too many consecutive tool errors")
          }

          spinner.start(colors.muted("thinking..."))
          response = await callServer({
            type: "tool_result",
            runId: response.runId,
            tool: response.tool,
            result: {
              error: (toolError as Error).message,
              success: false
            }
          })
        }
        break
      }

      default:
        spinner.stop()
        throw new Error(`Unexpected status: ${response.status}`)
    }
  }
}
