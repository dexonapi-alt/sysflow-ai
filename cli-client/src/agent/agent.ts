import os from "node:os"
import path from "node:path"
import readline from "node:readline"
import ora from "ora"
import { callServer, callServerStream, type ServerError } from "../lib/server.js"
import { ensureSysbase, getSelectedModel, getSysbasePath, getReasoningEnabled, getAuthToken } from "../lib/sysbase.js"
import { executeTool, executeToolsBatch } from "./executor.js"
import { readFileTool, computeLineDiff } from "./tools.js"
import { clearRunDiffs } from "./diff.js"
import { getOrBuildIndex, compactTree } from "./indexer.js"
import { ensureActiveChat } from "../commands/chats.js"
import {
  colors,
  BOX,
  boxTop,
  boxMid,
  boxBot,
  revealReasoning,
  formatToolLabel,
  isHiddenStep,
  renderMarkdown,
  renderPipelineBox,
  printStepTransition,
} from "../cli/render.js"
import {
  enableDiffExpand,
  disableDiffExpand,
  startDiffKeyListener,
} from "../cli/diff-preview.js"
import { renderToolResultPreview } from "../cli/tool-result-preview.js"
import { classifyResponse, makeRetryBudget, noteSuccess, type RetryBudget } from "./state-machine.js"

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ─── User input prompt ───

function askUser(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.question(colors.accent("  > "), (answer) => {
      rl.close()
      resolve(answer.trim())
    })
  })
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
      const result = await readFileTool(m.absolute)
      mentionedFiles.push({ path: m.path, content: result.content })
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

  const serverPayload = {
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
  }

  let response: Record<string, unknown>
  const budget: RetryBudget = makeRetryBudget()

  // Wrap callServerStream / callServer in a single retryable call. USAGE_LIMIT bubbles up.
  async function makeServerCall(payload: Record<string, unknown>, phaseHandler?: (label: string) => void): Promise<Record<string, unknown>> {
    try {
      return await callServerStream(payload, phaseHandler)
    } catch (err) {
      if ((err as ServerError).code === "USAGE_LIMIT") throw err
      return await callServer(payload)
    }
  }

  // ─── Initial call with task-driven retry on rate/usage limits ───
  let initialAttempts = 0
  const MAX_INITIAL_ATTEMPTS = 6
  while (true) {
    try {
      response = await makeServerCall(serverPayload, (label) => {
        spinner.text = colors.muted(label)
      })
      break
    } catch (err) {
      if ((err as ServerError).code === "USAGE_LIMIT" && initialAttempts < MAX_INITIAL_ATTEMPTS) {
        initialAttempts++
        const waitMs = Math.min(5000 * Math.pow(2, initialAttempts - 1), 120_000)
        spinner.stop()
        console.log("")
        console.log(colors.warning(`  ⚠ Usage limit hit — waiting ${Math.round(waitMs / 1000)}s before retry (${initialAttempts}/${MAX_INITIAL_ATTEMPTS})`))
        console.log(colors.muted("    The system will reduce usage and retry automatically."))
        await sleep(waitMs)
        spinner.start(colors.muted("retrying..."))
        continue
      }
      if ((err as ServerError).code === "USAGE_LIMIT") {
        spinner.stop()
        console.log("")
        console.log(colors.warning("  ⚠ " + (err as Error).message))
        console.log(colors.muted("  Exhausted all retry attempts."))
        console.log(colors.muted("  Run ") + colors.accent("sys billing") + colors.muted(" to upgrade your plan"))
        console.log("")
        return
      }
      spinner.stop()
      throw err
    }
  }

  let stepCount = 0
  let taskShown = false
  let taskSteps: Array<{ id: string; label: string; status?: string }> = []
  const completedSteps = new Set<string>()
  let lastDisplayedAction: string | null = null
  let lastDisplayedReasoning: string | null = null
  const currentRunId = (response.runId as string) || ""
  let lastPipelineStepId: string | null = null

  const cleanupDiffListener = startDiffKeyListener(spinner)

  while (true) {
    // Safety: detect misclassified responses — "completed" but message contains needs_tool JSON
    if (response.status === "completed") {
      const msg = (response.message || response.content || "") as string
      if (msg.trimStart().startsWith("{")) {
        try {
          const parsed = JSON.parse(msg)
          if (parsed.kind === "needs_tool" && (parsed.tool || parsed.tools)) {
            response.status = "needs_tool"
            response.tool = parsed.tool || undefined
            response.args = parsed.args || undefined
            if (parsed.args_json) {
              try { response.args = typeof parsed.args_json === "string" ? JSON.parse(parsed.args_json) : parsed.args_json } catch { /* ignore */ }
            }
            if (Array.isArray(parsed.tools)) {
              response.tools = parsed.tools.map((tc: Record<string, unknown>, i: number) => {
                let args: Record<string, unknown> = {}
                if (tc.args_json) {
                  try { args = typeof tc.args_json === "string" ? JSON.parse(tc.args_json as string) : tc.args_json as Record<string, unknown> } catch { /* */ }
                } else if (tc.args) {
                  args = tc.args as Record<string, unknown>
                }
                return { id: (tc.id as string) || `tc_${i}`, tool: tc.tool as string, args }
              })
            }
            response.reasoning = parsed.reasoning || null
            response.content = parsed.content || null
            response.message = null
          }
        } catch { /* not JSON */ }
      }
    }

    const transition = classifyResponse(response)

    // ─── Client-side completion verification: reject premature completion ───
    if (transition.terminal && transition.reason === "completed") {
      const completionMsg = ((response.message || response.content || "") as string).toLowerCase()
      const isComplexPrompt = /full[- ]?stack|backend.*frontend|multiple\s+modules|end[- ]?to[- ]?end|crud.*auth|nestjs.*next/i.test(prompt)
      const isShortCompletion = completionMsg.length < 150
      const hasListedFiles = /files?\s*(created|modified|written)/i.test(completionMsg)
      const tooFewSteps = stepCount < 5 && isComplexPrompt

      if (
        isComplexPrompt
        && (tooFewSteps || (isShortCompletion && !hasListedFiles))
        && response.runId
        && budget.completion_rejection.used < budget.completion_rejection.max
      ) {
        budget.completion_rejection.used++
        spinner.stop()
        console.log("")
        console.log(colors.warning(`  ⚠ Task appears incomplete (${stepCount} steps for a complex task)`))
        console.log(colors.muted(`    Auto-continuing... (attempt ${budget.completion_rejection.used}/${budget.completion_rejection.max})`))
        console.log("")
        spinner.start(colors.muted("continuing task..."))

        try {
          response = await makeServerCall({
            type: "tool_result",
            runId: response.runId,
            tool: "_completion_rejected",
            result: {
              error: `CLIENT REJECTION: The task is complex but only ${stepCount} steps were taken. Continue implementing all required files before completing.`,
              success: false,
              originalTask: prompt,
              hint: "Respond with needs_tool to continue. Do NOT respond with completed again until ALL files are created."
            }
          }, (label) => { spinner.text = colors.muted(label) })
        } catch {
          response = await callServer({
            type: "tool_result",
            runId: response.runId,
            tool: "_completion_rejected",
            result: { error: "Task incomplete. Continue implementing.", success: false, originalTask: prompt }
          })
        }
        continue
      }
    }

    // ─── Handle terminal transitions ───
    if (transition.terminal) {
      switch (transition.reason) {
        case "completed": {
          await renderCompletion(response, hasReasoning, lastDisplayedReasoning, taskSteps, completedSteps, stepCount)
          cleanupDiffListener()
          disableDiffExpand()
          if (currentRunId) clearRunDiffs(currentRunId)
          return response
        }
        case "session_expired": {
          spinner.stop()
          console.log("")
          console.log(colors.warning("  Session expired (server was restarted)."))
          console.log(colors.muted("  Run your prompt again with ") + colors.accent("sys \"your prompt\"") + colors.muted(" or ") + colors.accent("sys continue"))
          console.log("")
          cleanupDiffListener()
          return response
        }
        case "prompt_too_long": {
          spinner.stop()
          console.log("")
          console.log(colors.warning("  ⚠ " + ((response.error as string) || "Prompt too long")))
          console.log(colors.muted("  Try a shorter prompt or fewer @file mentions, or run ") + colors.accent("sys chat new") + colors.muted(" to start fresh."))
          console.log("")
          cleanupDiffListener()
          return response
        }
        case "malformed_response_exhausted": {
          spinner.stop()
          console.log("")
          console.log(colors.error("  ✖ Model returned malformed JSON repeatedly. Aborting."))
          console.log(colors.muted("  " + ((response.error as string) || "")))
          console.log("")
          cleanupDiffListener()
          throw new Error((response.error as string) || "malformed_response")
        }
        default: {
          spinner.stop()
          cleanupDiffListener()
          disableDiffExpand()
          if (currentRunId) clearRunDiffs(currentRunId)
          throw new Error(`Unexpected terminal: ${transition.reason}`)
        }
      }
    }

    // ─── Continue transitions ───
    switch (transition.reason) {
      case "tool_executed":
      case "tool_batch_executed": {
        const result = await handleNeedsTool(
          response,
          spinner,
          { hasReasoning, lastDisplayedAction, lastDisplayedReasoning, currentRunId, taskShown, taskSteps, completedSteps, lastPipelineStepId, budget },
          makeServerCall,
        )
        response = result.response
        stepCount = result.stepCount === undefined ? stepCount + 1 : stepCount + result.stepCount
        taskShown = result.taskShown
        taskSteps = result.taskSteps
        lastDisplayedAction = result.lastDisplayedAction
        lastDisplayedReasoning = result.lastDisplayedReasoning
        lastPipelineStepId = result.lastPipelineStepId
        noteSuccess(budget)
        break
      }

      case "user_responded": {
        spinner.stop()
        console.log("")
        const questionText = (response.message || response.content || "Waiting for your input") as string
        const renderedQ = renderMarkdown(questionText)
        for (const qLine of renderedQ.split("\n")) {
          console.log("  " + boxMid(qLine, 50))
        }
        console.log("")

        const userAnswer = await askUser(questionText)

        if (!userAnswer || userAnswer.toLowerCase() === "quit" || userAnswer.toLowerCase() === "exit") {
          console.log(colors.muted("  cancelled."))
          console.log("")
          cleanupDiffListener()
          return response
        }

        spinner.start(colors.muted("thinking..."))
        try {
          response = await makeServerCall({
            type: "tool_result",
            runId: response.runId,
            tool: "_user_response",
            result: { answer: userAnswer, success: true }
          }, (label) => { spinner.text = colors.muted(label) })
        } catch (userErr) {
          if ((userErr as ServerError).code === "USAGE_LIMIT") {
            budget.usage_limit.used++
            const waitMs = Math.min(10_000 * budget.usage_limit.used, budget.usage_limit.maxBackoffMs)
            spinner.stop()
            console.log(colors.warning(`  ⚠ Usage limit — waiting ${Math.round(waitMs / 1000)}s...`))
            await sleep(waitMs)
            spinner.start(colors.muted("retrying..."))
          }
          response = await callServer({
            type: "tool_result",
            runId: response.runId,
            tool: "_user_response",
            result: { answer: userAnswer, success: true }
          })
        }
        break
      }

      case "rate_limit_retry":
      case "usage_limit_retry":
      case "failure_retry": {
        const errorMsg = (response.error as string) || "Agent failed"
        const isRateLimit = transition.reason === "rate_limit_retry"
        const isUsageLimit = transition.reason === "usage_limit_retry"

        if (isRateLimit) {
          if (budget.rate_limit.used >= budget.rate_limit.max || !response.runId) {
            spinner.fail(colors.error(errorMsg))
            console.log(colors.muted(`  Exhausted rate-limit retries (${budget.rate_limit.used}/${budget.rate_limit.max})`))
            cleanupDiffListener()
            throw new Error(errorMsg)
          }
          budget.rate_limit.used++
          spinner.stop()
          console.log(colors.warning(`  ⚠ Rate limited — waiting ${Math.round(budget.rate_limit.backoffMs / 1000)}s (retry ${budget.rate_limit.used}/${budget.rate_limit.max})`))
          await sleep(budget.rate_limit.backoffMs)
          budget.rate_limit.backoffMs = Math.min(budget.rate_limit.backoffMs * 2, budget.rate_limit.maxBackoffMs)
          spinner.start(colors.muted("retrying after rate limit..."))
        } else if (isUsageLimit) {
          if (budget.usage_limit.used >= budget.usage_limit.max) {
            spinner.fail(colors.error(errorMsg))
            cleanupDiffListener()
            throw new Error(errorMsg)
          }
          budget.usage_limit.used++
          const waitMs = Math.min(budget.usage_limit.baseMs * Math.pow(2, budget.usage_limit.used - 1), budget.usage_limit.maxBackoffMs)
          spinner.stop()
          console.log(colors.warning(`  ⚠ Usage limit — waiting ${Math.round(waitMs / 1000)}s (retry ${budget.usage_limit.used}/${budget.usage_limit.max})`))
          await sleep(waitMs)
          spinner.start(colors.muted("retrying after usage limit..."))
        } else {
          if (stepCount === 0 || budget.failure.used >= budget.failure.max || !response.runId) {
            spinner.fail(colors.error(errorMsg))
            if (budget.rate_limit.used > 0 || budget.failure.used > 0) {
              console.log(colors.muted(`  Exhausted retries: ${budget.rate_limit.used} rate limit, ${budget.failure.used} failure retries`))
            }
            cleanupDiffListener()
            throw new Error(errorMsg)
          }
          budget.failure.used++
          budget.failure.consecutiveErrors++
          spinner.stop()
          if (budget.failure.consecutiveErrors >= budget.failure.maxConsecutive && budget.failure.used >= budget.failure.max) {
            console.log(colors.error(`  ${BOX.cross} ${errorMsg}`))
            console.log(colors.error(`  Task failed after ${budget.failure.used} retries and ${budget.failure.consecutiveErrors} consecutive errors.`))
            console.log("")
            cleanupDiffListener()
            throw new Error(errorMsg)
          }
          console.log(colors.error(`  ${BOX.cross} ${errorMsg}`))
          console.log(colors.muted(`    Auto-retrying (${budget.failure.used}/${budget.failure.max})...`))
          spinner.start(colors.muted("retrying..."))
        }

        // Re-issue _recovery to push the agent forward.
        const recoveryHint = isRateLimit
          ? "Rate limit was hit. The system waited and is retrying. Continue with the task using fewer tokens if possible."
          : isUsageLimit
            ? "Usage limit was hit. Reduce token usage and continue the task."
            : "Please fix the issue and continue. Do NOT give up. Respond with needs_tool to take the next action."

        try {
          response = await makeServerCall({
            type: "tool_result",
            runId: response.runId,
            tool: "_recovery",
            result: { error: errorMsg, success: false, hint: recoveryHint }
          }, (label) => { spinner.text = colors.muted(label) })
        } catch (retryErr) {
          if ((retryErr as ServerError).code === "USAGE_LIMIT") {
            response = { ...response, status: "failed", error: errorMsg, errorCode: "usage_limit" }
          } else {
            response = await callServer({
              type: "tool_result",
              runId: response.runId,
              tool: "_recovery",
              result: { error: errorMsg, success: false, hint: recoveryHint }
            })
          }
        }
        break
      }

      case "completion_rejected": {
        // Triggered manually by client-side completion verification (handled in handleCompletion path).
        break
      }

      case "next_turn":
      default:
        break
    }
  }
}

// ─── Render the final completion state ───

async function renderCompletion(
  response: Record<string, unknown>,
  hasReasoning: boolean,
  lastDisplayedReasoning: string | null,
  taskSteps: Array<{ id: string; label: string; status?: string }>,
  completedSteps: Set<string>,
  stepCount: number,
): Promise<void> {
  let message = (response.message || response.content) as string | null
  const reasoning = response.reasoning as string | null

  if (message && message.trimStart().startsWith("{")) {
    try {
      const parsed = JSON.parse(message)
      if (parsed.content && typeof parsed.content === "string") {
        message = parsed.content
      }
    } catch { /* not JSON */ }
  }

  if (hasReasoning && reasoning && reasoning !== lastDisplayedReasoning && reasoning !== message) {
    await revealReasoning(reasoning)
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
    for (const s of taskSteps) {
      completedSteps.add(s.id)
      s.status = "completed"
    }
    const completedTask = response.task as Record<string, unknown> | null
    const title = (completedTask?.title as string) || `${completedSteps.size}/${taskSteps.length} COMPLETE`
    const goal = (completedTask?.goal as string) || ""
    renderPipelineBox(title, goal, taskSteps, completedSteps)
    console.log("")
  }

  if (message) {
    const rendered = renderMarkdown(message)
    const renderedLines = rendered.split("\n")
    console.log("  " + boxTop("SUMMARY", 50))
    for (const line of renderedLines) {
      console.log("  " + boxMid(line, 50))
    }
    console.log("  " + boxBot(50))
    console.log("")
  }

  const doneText = `  ${colors.success(BOX.check)} done`
  const stepText = colors.muted(` ${BOX.dash} ${stepCount} steps`)
  process.stdout.write(doneText)
  await sleep(60)
  console.log(stepText)
  console.log("")
}

// ─── Handle a needs_tool transition (single or batch) ───

interface NeedsToolCtx {
  hasReasoning: boolean
  lastDisplayedAction: string | null
  lastDisplayedReasoning: string | null
  currentRunId: string
  taskShown: boolean
  taskSteps: Array<{ id: string; label: string; status?: string }>
  completedSteps: Set<string>
  lastPipelineStepId: string | null
  budget: RetryBudget
}

interface NeedsToolResult {
  response: Record<string, unknown>
  stepCount?: number
  taskShown: boolean
  taskSteps: Array<{ id: string; label: string; status?: string }>
  lastDisplayedAction: string | null
  lastDisplayedReasoning: string | null
  lastPipelineStepId: string | null
}

async function handleNeedsTool(
  response: Record<string, unknown>,
  spinner: ReturnType<typeof ora>,
  ctx: NeedsToolCtx,
  makeServerCall: (payload: Record<string, unknown>, phaseHandler?: (label: string) => void) => Promise<Record<string, unknown>>,
): Promise<NeedsToolResult> {
  const { hasReasoning, currentRunId, completedSteps, budget } = ctx
  let { lastDisplayedAction, lastDisplayedReasoning, taskShown, taskSteps, lastPipelineStepId } = ctx

  // Step transition handling
  const stepTransition = response.stepTransition as { complete?: string; start?: string } | undefined
  if (stepTransition?.complete) completedSteps.add(stepTransition.complete)

  const toolCalls = response.tools as Array<{ id: string; tool: string; args: Record<string, unknown> }> | undefined
  const isParallel = toolCalls && toolCalls.length > 1

  // Pipeline display
  const task = response.task as Record<string, unknown> | null
  if (task) {
    const incomingSteps = (task.steps || []) as Array<{ id: string; label: string; status?: string }>
    for (const s of incomingSteps) {
      if (s.status === "completed" && s.id) completedSteps.add(s.id)
      const existing = taskSteps.find((ts) => ts.id === s.id)
      if (existing) existing.status = s.status
    }
    taskSteps = incomingSteps

    if (!taskShown) {
      spinner.stop()
      taskShown = true
      console.log("")
      renderPipelineBox(task.title as string, task.goal as string, taskSteps, completedSteps)
      console.log("")
      const activeStep = taskSteps.find((s) => s.status === "in_progress")
      lastPipelineStepId = activeStep?.id || null
      spinner.start(colors.muted("thinking..."))
    } else if (stepTransition) {
      spinner.stop()
      const completedStep = stepTransition.complete ? taskSteps.find((s) => s.id === stepTransition.complete) : undefined
      const startedStep = stepTransition.start ? taskSteps.find((s) => s.id === stepTransition.start) : undefined
      if (startedStep && startedStep.label && startedStep.id !== lastPipelineStepId) {
        console.log("")
        printStepTransition(completedStep?.label || null, startedStep.label)
        lastPipelineStepId = startedStep.id
      }
      spinner.start(colors.muted("thinking..."))
    }
  }

  if (isParallel) {
    spinner.stop()

    if (hasReasoning && response.reasoning && response.reasoning !== lastDisplayedReasoning) {
      lastDisplayedReasoning = response.reasoning as string
      await revealReasoning(response.reasoning as string)
    }

    const hasCommands = toolCalls!.some((tc) => tc.tool === "run_command")

    console.log("")
    const batchLabel = hasCommands ? "batch" : "parallel"
    console.log(colors.accent(`    ${BOX.tl}${BOX.h}${BOX.h} ${batchLabel} `) + colors.muted(`(${toolCalls!.length} tools)`))

    for (let i = 0; i < toolCalls!.length; i++) {
      const tc = toolCalls![i]
      const label = formatToolLabel(tc.tool, tc.args)
      await sleep(30)
      console.log(colors.accent(`    ${BOX.v}`) + `  ${colors.muted(BOX.ring)} ` + (label || `${tc.tool} ${JSON.stringify(tc.args)}`))
    }

    if (hasCommands) {
      console.log("")
      try {
        response = await executeToolsBatch(toolCalls!, response.runId as string)
      } catch (batchError) {
        budget.failure.consecutiveErrors++
        console.log(colors.accent(`    ${BOX.bl}${BOX.h}${BOX.h}`) + ` ${colors.error("error:")} ` + colors.muted((batchError as Error).message))
        if (budget.failure.consecutiveErrors >= budget.failure.maxConsecutive) {
          console.log(colors.error(`\n  aborted: ${budget.failure.maxConsecutive} consecutive errors`))
          throw new Error("Too many consecutive tool errors")
        }
        spinner.start(colors.muted("thinking..."))
        response = await callServer({
          type: "tool_result",
          runId: response.runId,
          tool: "_recovery",
          result: { error: (batchError as Error).message, success: false }
        })
        return { response, taskShown, taskSteps, lastDisplayedAction, lastDisplayedReasoning, lastPipelineStepId }
      }
      console.log(colors.accent(`    ${BOX.bl}${BOX.h}${BOX.h}`) + ` ${colors.success("done")}`)
      console.log("")
      spinner.start(colors.muted("thinking..."))
      return { response, taskShown, taskSteps, lastDisplayedAction, lastDisplayedReasoning, lastPipelineStepId }
    }

    spinner.start(colors.muted(`  executing ${toolCalls!.length} tools...`))

    try {
      response = await executeToolsBatch(toolCalls!, response.runId as string, (label) => {
        spinner.text = colors.muted(`  ${label}`)
      })
      spinner.stop()

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
      budget.failure.consecutiveErrors++
      spinner.stop()
      console.log(colors.accent(`    ${BOX.bl}${BOX.h}${BOX.h}`) + ` ${colors.error("error:")} ` + colors.muted((batchError as Error).message))
      if (budget.failure.consecutiveErrors >= budget.failure.maxConsecutive) {
        console.log(colors.error(`\n  aborted: ${budget.failure.maxConsecutive} consecutive errors`))
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
    return { response, taskShown, taskSteps, lastDisplayedAction, lastDisplayedReasoning, lastPipelineStepId }
  }

  // ── SINGLE TOOL PATH ──
  const singleFromArray = (!response.tool && Array.isArray(response.tools) && (response.tools as Array<Record<string, unknown>>).length === 1)
    ? (response.tools as Array<Record<string, unknown>>)[0]
    : null
  if (singleFromArray) {
    response.tool = singleFromArray.tool
    response.args = singleFromArray.args
  }

  const pendingTaskStep = (response.taskStep as string) || null
  const args = (response.args || {}) as Record<string, unknown>

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
    if (hasReasoning && response.reasoning && response.reasoning !== lastDisplayedReasoning) {
      lastDisplayedReasoning = response.reasoning as string
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
      const cmd = (args?.command as string) || ""
      const isInteractiveCmd = cmd ? /^npx\s+(--yes\s+)?(create-|@nestjs\/cli|@angular\/cli|nuxi)|^npm\s+(create|init)|^yarn\s+create|^pnpm\s+create/.test(cmd.trim()) : false
      if (isInteractiveCmd) {
        console.log(`    ${colors.accent(BOX.arrow)} ${colors.tool("run")} ${colors.bright(cmd)}`)
        console.log(colors.muted("    (interactive — answer prompts below)"))
      } else {
        spinner.start(colors.muted("  ") + colors.bright(cmd))
      }
    } else {
      const label = formatToolLabel(response.tool as string, args)
      const hasDiff = response.tool === "write_file" || response.tool === "edit_file"
      if (hasDiff) {
        let added = 0, removed = 0
        if (args.search !== undefined && response.tool === "edit_file") {
          const searchLines = ((args.search as string) || "").split("\n").length
          const replaceLines = ((args.replace as string) || "").split("\n").filter(Boolean).length
          removed = searchLines
          added = replaceLines
        } else if (args.line_start !== undefined && response.tool === "edit_file") {
          const lineStart = args.line_start as number
          const lineEnd = (args.line_end as number) || lineStart
          removed = lineEnd - lineStart + 1
          added = ((args.content as string) || "").split("\n").length
        } else if (args.insert_at !== undefined && response.tool === "edit_file") {
          added = ((args.content as string) || "").split("\n").length
        } else {
          const newContent = (args.content || args.patch || "") as string
          let oldContent: string | null = null
          try { oldContent = (await readFileTool(args.path as string)).content } catch { /* new file */ }
          const lineDiff = computeLineDiff(oldContent, newContent)
          added = lineDiff.added
          removed = lineDiff.removed
        }
        const parts: string[] = []
        if (added > 0) parts.push(colors.success(`+${added}`))
        if (removed > 0) parts.push(colors.error(`-${removed}`))
        const diffTag = parts.length > 0 ? " " + parts.join(colors.muted(" ")) : ""
        const tabHint = (added > 0 || removed > 0) ? colors.muted("  [Tab → diff]") : ""
        console.log(`    ${colors.accent(BOX.arrow)} ${label}${diffTag}${tabHint}`)
        if (added > 0 || removed > 0) {
          enableDiffExpand(currentRunId || (response.runId as string) || "")
        }
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
    response = await executeTool(response as never, (label) => {
      spinner.text = colors.muted(label)
    })

    // ─── Tool-result preview: replace the silent spinner gap with a one-liner ───
    if (!isHiddenStep(currentTool)) {
      const toolResult = response.lastToolResult as Record<string, unknown> | undefined
      const preview = renderToolResultPreview({ tool: currentTool, result: toolResult })
      if (preview) {
        spinner.stop()
        console.log(preview)
        spinner.start(colors.muted("thinking..."))
      }
    }

    if (currentTool === "run_command") {
      spinner.stop()
      const toolResult = response.lastToolResult as Record<string, unknown> | undefined
      if (toolResult?.skipped) {
        console.log(colors.warning(`  ⚠ `) + colors.muted(currentCmd) + colors.warning(" (run manually)"))
      } else if (toolResult?.timedOut) {
        console.log(colors.warning(`  ⏱ `) + colors.muted(currentCmd) + colors.warning(" (timed out)"))
        console.log(colors.warning("  command timed out — continuing task..."))
      } else if (toolResult?.interactive) {
        console.log("")
        console.log(`  ${colors.success(BOX.check)} ` + colors.muted(currentCmd) + colors.success(" (done)"))
        console.log(colors.accent("  continuing task..."))
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
    budget.failure.consecutiveErrors++
    spinner.stop()
    if (currentTool === "run_command") {
      console.log(colors.error(`  ${BOX.cross} `) + colors.muted(currentCmd) + colors.error(` — ${(toolError as Error).message}`))
    } else {
      console.log(colors.error(`    ${BOX.cross} ${(toolError as Error).message}`))
    }

    if (budget.failure.consecutiveErrors >= budget.failure.maxConsecutive) {
      console.log(colors.error(`\n  aborted: ${budget.failure.maxConsecutive} consecutive errors`))
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
        success: false,
        path: args?.path || undefined
      }
    })
  }

  return { response, taskShown, taskSteps, lastDisplayedAction, lastDisplayedReasoning, lastPipelineStepId }
}
