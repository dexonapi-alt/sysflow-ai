import fs from "node:fs/promises"
import path from "node:path"
import { getRun, finalizeRun } from "../store/runs.js"
import { getTask, finalizeTask } from "../store/tasks.js"
import { saveToolResult } from "../store/tool-results.js"
import { persistModelUsage } from "../store/usage.js"
import { maybeUpdateProjectMemory } from "../store/memory.js"
import { recordRunAction, saveSessionEntry, getRunActions, clearRunActions } from "../store/sessions.js"
import { saveContext } from "../store/context.js"
import { loadRunContext } from "../services/context.js"
import { callModelAdapter } from "../providers/adapter.js"
import { mapNormalizedResponseToClient } from "../providers/normalize.js"
import { validateCompletion, buildRejectionPayload, analyzeTaskComplexity } from "../services/completion-guard.js"
import { recordVerificationResult, shouldBlockCompletion, buildVerificationFixPayload, getVerificationState, clearVerificationState } from "../services/verification-guard.js"
import { validateFrontendQuality, buildFrontendRejectionPayload, accumulateFrontendContent, clearFrontendContent } from "../services/frontend-quality-guard.js"
import { actionPlanner } from "../services/action-planner.js"
import { isFrontendTask } from "../knowledge/frontend-patterns.js"
import { ingestToolResult, clearRunContext, buildWorkingContextString } from "../services/context-manager.js"
import { updatePipelineProgress, completePipeline, clearPipeline, getPipeline, hasPipeline, pipelineToTaskMeta, createPipelineFromAiPlan, createFallbackPipeline } from "../services/task-pipeline.js"
import { getScaffoldChoice, storeScaffoldChoice, parseScaffoldResponse, clearScaffoldState } from "../services/scaffold-options.js"
import { getPendingError, clearPendingError, setPendingError, buildFixInstructions, setPendingFileContent, hasPendingErrors, popNextPendingError } from "../services/error-autofix.js"
import { applyToolResultBudget, estimateTokens, shouldBlockOnTokens } from "../services/context-budget.js"
import { classifyToolError } from "../services/tool-error-classifier.js"
import type { ClientResponse, NormalizedResponse } from "../types.js"

/** Track how many times completion was rejected per run (prevent infinite loops) */
const completionRejections = new Map<string, number>()
const MAX_COMPLETION_REJECTIONS = 3

/** Track frontend quality rejections per run (separate from structural completion guard) */
const frontendQualityRejections = new Map<string, number>()
const MAX_FRONTEND_QUALITY_REJECTIONS = 2

interface ToolResultBody {
  runId: string
  tool: string
  result: Record<string, unknown>
  toolResults?: Array<{ id: string; tool: string; result: Record<string, unknown> }>
}

export async function handleToolResult(body: ToolResultBody): Promise<ClientResponse> {
  const isBatch = body.toolResults && body.toolResults.length > 0

  // ─── Tool result budget: clamp oversized results before saving or sending to provider ───
  if (isBatch) {
    body.toolResults = body.toolResults!.map((tr) => ({
      ...tr,
      result: applyToolResultBudget(tr.tool, tr.result),
    }))
    for (const tr of body.toolResults) {
      await saveToolResult(body.runId, tr.tool, tr.result)
    }
  } else {
    body.result = applyToolResultBudget(body.tool, body.result)
    await saveToolResult(body.runId, body.tool, body.result)
  }

  let run: Awaited<ReturnType<typeof getRun>>
  try {
    run = await getRun(body.runId)
  } catch {
    return {
      status: "failed",
      runId: body.runId,
      error: "Session expired. The server was restarted and lost this run's state. Please start a new prompt."
    }
  }

  // ─── Scaffold choice injection: when user responds to scaffold question, inject the command ───
  if (body.tool === "_user_response") {
    const userAnswer = (body.result.answer as string) || (body.result.content as string) || ""
    // Check if this looks like a scaffold choice response (number or keyword)
    if (/^\s*[1-9]\s*$/.test(userAnswer.trim()) || /\b(vite|next|nest|manual|create)\b/i.test(userAnswer)) {
      // Import scaffold options dynamically to parse the choice
      const { parseScaffoldResponse, detectScaffoldingNeed } = await import("../services/scaffold-options.js")
      // We need the original prompt to regenerate options
      const options = detectScaffoldingNeed(run.content, []) // empty tree since we already confirmed scaffolding is needed
      if (options) {
        const choice = parseScaffoldResponse(userAnswer, options)
        if (choice && choice.command) {
          // Inject the exact scaffold command into planner context so the AI uses it
          const projectName = run.content.match(/(?:called|named|for)\s+(\w+)/i)?.[1]?.toLowerCase() || "my-app"
          const resolvedCommand = choice.command.replace("{name}", projectName)
          actionPlanner.injectContext(body.runId,
            `[SCAFFOLD CHOICE] The user chose: "${choice.label}"\nRun this EXACT command: ${resolvedCommand}\nUse run_command with command: "${resolvedCommand}"\nAfter scaffolding, read the generated package.json to verify, then create all source files.`
          )
          console.log(`[scaffold] User chose "${choice.label}" — injecting command: ${resolvedCommand}`)
        } else if (choice && !choice.command) {
          actionPlanner.injectContext(body.runId,
            `[SCAFFOLD CHOICE] The user chose to create files manually. Do NOT run any scaffolding commands. Create all project files directly with write_file (package.json, index.html, src/*, etc).`
          )
          console.log(`[scaffold] User chose manual file creation`)
        }
      }
    }
  }

  // Record actions for each tool AND feed results to action planner + context manager
  if (isBatch) {
    for (const tr of body.toolResults!) {
      recordRunAction(body.runId, tr.tool, tr.result, run.projectId)
      ingestToolResult(body.runId, tr.tool, tr.result, tr.result)
      updatePipelineProgress(body.runId, tr.tool, tr.result)
    }
    actionPlanner.recordBatchResults(body.runId, body.toolResults!.map((tr) => ({ tool: tr.tool, result: tr.result })))
  } else {
    recordRunAction(body.runId, body.tool, body.result, run.projectId)
    actionPlanner.recordResult(body.runId, body.tool, body.result)
    ingestToolResult(body.runId, body.tool, body.result, body.result)
    updatePipelineProgress(body.runId, body.tool, body.result)
  }

  // ─── Process verification results from client-side auto-verify ───
  if (isBatch) {
    for (const tr of body.toolResults!) {
      if (tr.tool === "_verification") {
        const passed = tr.result.passed === true
        const errors = (tr.result.errors || []) as string[]
        const warnings = (tr.result.warnings || []) as string[]
        recordVerificationResult(body.runId, passed, errors, warnings)
      }
      // Lint errors are treated as verification errors too
      if (tr.tool === "_lint" && tr.result.passed === false) {
        const lintErrors = (tr.result.errors || []) as string[]
        recordVerificationResult(body.runId, false, lintErrors, [])
      }
    }
  } else if (body.tool === "_verification") {
    const passed = body.result.passed === true
    const errors = (body.result.errors || []) as string[]
    const warnings = (body.result.warnings || []) as string[]
    recordVerificationResult(body.runId, passed, errors, warnings)
  }

  // ─── Per-file lint errors: inject into planner context so AI fixes them immediately ───
  if (!isBatch && body.result.lint && (body.result.lint as Record<string, unknown>).passed === false) {
    const lintErrors = ((body.result.lint as Record<string, unknown>).errors || []) as string[]
    if (lintErrors.length > 0) {
      const filePath = body.result.path as string || "unknown"
      actionPlanner.injectContext(body.runId,
        `[LINT ERRORS] Your write/edit to "${filePath}" has ${lintErrors.length} error(s). Fix these BEFORE proceeding:\n` +
        lintErrors.map(e => `  ${e}`).join("\n") +
        `\nUse read_file to see the current content, then edit_file to fix each error.`
      )
      // Also record as verification errors so completion guard catches them
      recordVerificationResult(body.runId, false, lintErrors, [])
    }
  }

  const task = await getTask(run.taskId)
  const context = await loadRunContext({
    runId: body.runId,
    taskId: run.taskId,
    projectId: run.projectId,
    cwd: run.cwd as string,
    sysbasePath: run.sysbasePath as string | undefined
  })

  // ─── Inject managed working context ───
  const workingContext = buildWorkingContextString(body.runId)
  if (workingContext) {
    (context as Record<string, unknown>).workingContext = workingContext
  }

  // Build provider payload with single or batch results
  const providerPayload: Record<string, unknown> = {
    model: run.model,
    runId: body.runId,
    task: task,
    context: context,
    userMessage: run.content,
    command: run.command as string | undefined,
    projectId: run.projectId,
    userId: run.userId || null,
    chatId: run.chatId || null
  }

  if (isBatch) {
    providerPayload.toolResults = enrichErrorResults(body.toolResults!)
    // Also set toolResult to first item for backwards compat
    providerPayload.toolResult = {
      tool: body.toolResults![0].tool,
      result: body.toolResults![0].result
    }
  } else {
    const enriched = enrichSingleError(body.tool, body.result)
    providerPayload.toolResult = {
      tool: body.tool,
      result: enriched
    }
  }

  // ─── Error-Aware Fix: when we forced a read_file for an error, inject fix instructions into AI context ───
  const pendingError = getPendingError(body.runId)
  if (pendingError && body.tool === "read_file") {
    clearPendingError(body.runId)

    if (body.result.success !== false && !body.result.error) {
      const fileContent = (body.result.content as string) || (body.result.data as string) || ""
      if (fileContent) {
        // Build specific instructions telling the AI exactly what line to remove
        const fixInstructions = buildFixInstructions(pendingError, fileContent)
        console.log(`[error-aware] Read succeeded — injecting fix instructions for AI`)
        actionPlanner.injectContext(body.runId, fixInstructions)
        // Store file content for programmatic fix fallback (if AI fails to produce valid edit args)
        setPendingFileContent(body.runId, fileContent)
      }
    } else {
      // Read failed — FORCE a search_files call (don't rely on AI to follow instructions)
      const fileName = pendingError.sourceFile.split("/").pop() || pendingError.sourceFile
      console.log(`[error-aware] Read failed for "${pendingError.sourceFile}" — forcing search_files for "${fileName}"`)

      // Re-store the error so we can pick it up when the search result comes back
      setPendingError(body.runId, { ...pendingError, type: "import-error" as const })

      const searchAction: NormalizedResponse = {
        kind: "needs_tool",
        tool: "search_files",
        args: { query: fileName, glob: `**/${fileName.replace(/\.[jt]sx?$/, ".*")}` },
        content: `File "${pendingError.sourceFile}" not found — searching for it.`,
        reasoning: `The exact path doesn't exist. Searching for the file to find its actual location.`,
        usage: { inputTokens: 0, outputTokens: 0 },
        task: hasPipeline(body.runId) ? pipelineToTaskMeta(getPipeline(body.runId)!) : undefined
      }

      return mapNormalizedResponseToClient(body.runId, searchAction)
    }
    // Fall through to AI model — it will see the file content + instructions
  }

  // ─── Error-Aware Fix: search_files result came back — now force read on found file ───
  const pendingSearchError = getPendingError(body.runId)
  if (pendingSearchError && body.tool === "search_files") {
    clearPendingError(body.runId)

    // search_files returns results as a newline-joined string
    const rawResults = (body.result.results as string) || ""
    const resultLines = rawResults.split("\n").map((l: string) => l.trim()).filter((l: string) => l && !l.startsWith("No files"))

    // Find the matching file from search results
    const targetName = pendingSearchError.sourceFile.split("/").pop() || ""
    const baseName = targetName.replace(/\.[^.]+$/, "") // "FeaturesGrid" without extension
    const found = resultLines.find((r: string) => r.includes(targetName))
      || resultLines.find((r: string) => r.includes(baseName))
      || resultLines[0]

    if (found) {
      console.log(`[error-aware] Search found "${found}" — forcing read_file`)
      // Update sourceFile to the found path and re-store for the read result handler
      const updatedError = { ...pendingSearchError, sourceFile: found }
      setPendingError(body.runId, updatedError)

      const readAction: NormalizedResponse = {
        kind: "needs_tool",
        tool: "read_file",
        args: { path: found },
        content: `Found "${found}" — reading it to apply the fix.`,
        reasoning: `Located the file. Reading it to find and remove the broken import.`,
        usage: { inputTokens: 0, outputTokens: 0 },
        task: hasPipeline(body.runId) ? pipelineToTaskMeta(getPipeline(body.runId)!) : undefined
      }

      return mapNormalizedResponseToClient(body.runId, readAction)
    } else {
      console.log(`[error-aware] Search found nothing for "${targetName}" — telling AI`)
      actionPlanner.injectContext(body.runId,
        `[ERROR-FIX] Could not find the file "${pendingSearchError.sourceFile}" anywhere in the project.\n` +
        `The file may have a different extension (.js/.jsx/.tsx/.ts). Try list_directory on "src/components" to see what files exist.\n` +
        `Once you find it, read_file it and use edit_file search/replace to remove the import containing "${pendingSearchError.targetImport}".\n` +
        `Do NOT create new files or directories.`
      )
    }
  }

  // ─── Pre-API token guard ───
  const incomingPayloadTokens =
    estimateTokens(providerPayload.toolResult) +
    estimateTokens(providerPayload.toolResults) +
    estimateTokens((context as Record<string, unknown>).workingContext)
  if (shouldBlockOnTokens(incomingPayloadTokens, run.model)) {
    console.warn(`[token-guard] BLOCKED tool result: estimated ${incomingPayloadTokens} tokens exceeds ${run.model} effective window`)
    return {
      status: "failed",
      runId: body.runId,
      error: `Tool result too large (~${incomingPayloadTokens} tokens). Reducing future result sizes via tool-result budget.`,
      errorCode: "prompt_too_long",
    } as ClientResponse
  }

  let normalized = await callModelAdapter(providerPayload as never)

  await persistModelUsage({
    runId: body.runId,
    projectId: run.projectId,
    model: run.model,
    usage: normalized.usage,
    userId: run.userId || null
  })

  // ─── ACTION PLANNER: fix broken tools, detect loops, transform actions ───
  normalized = actionPlanner.intercept(body.runId, normalized)

  // ─── FRONTEND QUALITY: accumulate content from write operations for quality analysis ───
  if (isFrontendTask(run.content)) {
    accumulateFrontendContent(body.runId, normalized)
  }

  // ─── FATAL TERMINATION: bypass all guards if the model is fundamentally broken ───
  const isFatal = actionPlanner.isFatalTermination(body.runId)

  // ─── MULTI-ERROR QUEUE: if AI completed but more errors remain, fix the next one ───
  if (normalized.kind === "completed" && !isFatal && hasPendingErrors(body.runId)) {
    const nextError = popNextPendingError(body.runId)
    if (nextError) {
      console.log(`[error-aware] AI completed but ${hasPendingErrors(body.runId) ? "more" : "1"} error(s) remain — fixing "${nextError.targetImport}" in "${nextError.sourceFile}"`)
      setPendingError(body.runId, nextError)
      const fileName = nextError.sourceFile.split("/").pop() || nextError.sourceFile
      const baseName = fileName.replace(/\.[^.]+$/, "")

      normalized = {
        kind: "needs_tool",
        tool: "search_files",
        args: { query: baseName, glob: `**/${baseName}.*` },
        content: `Fixing next error: searching for "${baseName}" to remove broken import "${nextError.targetImport}".`,
        reasoning: `Previous fix completed. Now fixing: ${nextError.description}`,
        usage: normalized.usage,
        task: hasPipeline(body.runId) ? pipelineToTaskMeta(getPipeline(body.runId)!) : undefined
      }
    }
  }

  // ─── COMPLETION GUARD: reject premature completion (skip if fatal) ───
  if (normalized.kind === "completed" && !isFatal) {
    const rejectionCount = completionRejections.get(body.runId) || 0

    if (rejectionCount < MAX_COMPLETION_REJECTIONS) {
      const verdict = validateCompletion(body.runId, run.content)

      if (!verdict.pass) {
        completionRejections.set(body.runId, rejectionCount + 1)
        console.log(`[completion-guard] REJECTED completion for run ${body.runId} (attempt ${rejectionCount + 1}/${MAX_COMPLETION_REJECTIONS}): ${verdict.reason?.slice(0, 150)}`)

        // Send rejection back to the AI as a tool result — force it to continue
        const rejection = buildRejectionPayload(verdict.reason!, run.content)
        const retryPayload = {
          ...providerPayload,
          toolResult: { tool: rejection.tool, result: rejection.result },
          toolResults: undefined
        }

        const retryNormalized = await callModelAdapter(retryPayload as never)
        await persistModelUsage({
          runId: body.runId,
          projectId: run.projectId,
          model: run.model,
          usage: retryNormalized.usage,
          userId: run.userId || null
        })

        // If AI STILL says completed after rejection, let it through on subsequent attempts
        // (prevents infinite loops — after MAX_COMPLETION_REJECTIONS, we accept)
        normalized = retryNormalized
      }
    } else {
      // Max rejections reached — accept completion and clean up
      completionRejections.delete(body.runId)
    }
  }

  // ─── VERIFICATION GUARD: block completion if code has errors (skip if fatal) ───
  if (normalized.kind === "completed" && !isFatal) {
    const verBlock = shouldBlockCompletion(body.runId)
    if (verBlock.block) {
      const verState = getVerificationState(body.runId)!
      const fixPayload = buildVerificationFixPayload(verState)
      console.log(`[verification-guard] Blocking completion: ${verState.lastErrors.length} unresolved errors`)

      normalized = {
        kind: "needs_tool",
        tool: fixPayload.tool,
        args: fixPayload.args,
        content: fixPayload.content,
        reasoning: `Verification found errors. Reading files to fix them before completing.`,
        usage: normalized.usage
      }
    }
  }

  // ─── FRONTEND QUALITY GUARD: reject completion if UI code is too basic (skip if fatal) ───
  if (normalized.kind === "completed" && !isFatal && isFrontendTask(run.content)) {
    const frontendRejections = frontendQualityRejections.get(body.runId) || 0
    if (frontendRejections < MAX_FRONTEND_QUALITY_REJECTIONS) {
      const qualityResult = validateFrontendQuality(body.runId, run.content)

      if (!qualityResult.pass) {
        frontendQualityRejections.set(body.runId, frontendRejections + 1)
        console.log(`[frontend-quality] REJECTED: score ${qualityResult.score}/100 (anim: ${qualityResult.animationScore}, style: ${qualityResult.styleScore}, struct: ${qualityResult.structureScore}) — attempt ${frontendRejections + 1}/${MAX_FRONTEND_QUALITY_REJECTIONS}`)

        const rejection = buildFrontendRejectionPayload(qualityResult.reason!, run.content)
        const retryPayload = {
          ...providerPayload,
          toolResult: { tool: rejection.tool, result: rejection.result },
          toolResults: undefined
        }

        const retryNormalized = await callModelAdapter(retryPayload as never)
        await persistModelUsage({
          runId: body.runId,
          projectId: run.projectId,
          model: run.model,
          usage: retryNormalized.usage,
          userId: run.userId || null
        })

        normalized = retryNormalized
      }
    } else {
      frontendQualityRejections.delete(body.runId)
    }
  }

  // Clean up state on terminal states
  if (normalized.kind === "completed" || normalized.kind === "failed") {
    completionRejections.delete(body.runId)
    frontendQualityRejections.delete(body.runId)
    clearVerificationState(body.runId)
    actionPlanner.clear(body.runId)
    clearRunContext(body.runId)
    clearFrontendContent(body.runId)
  }

  // ─── Task Pipeline: create from AI plan if not yet created, then track progress ───
  if (normalized.kind === "needs_tool") {
    // If AI sent a taskPlan and we don't have a pipeline yet, create one
    if (normalized.taskPlan && normalized.taskPlan.steps.length > 0 && !hasPipeline(body.runId)) {
      const pipeline = createPipelineFromAiPlan(body.runId, run.content, normalized.taskPlan)
      normalized.task = pipelineToTaskMeta(pipeline)
    }
    // If still no pipeline, create fallback
    if (!hasPipeline(body.runId)) {
      createFallbackPipeline(body.runId, run.content)
    }

    const pipelineUpdate = updatePipelineProgress(
      body.runId,
      normalized.tool || "",
      (normalized.args || {}) as Record<string, unknown>
    )
    if (pipelineUpdate) {
      normalized.task = pipelineUpdate.task
      if (pipelineUpdate.stepTransition) {
        normalized.stepTransition = pipelineUpdate.stepTransition
      }
    }
  } else if (normalized.kind === "completed") {
    const completed = completePipeline(body.runId)
    if (completed) {
      normalized.task = completed
    }
    clearPipeline(body.runId)
  } else if (normalized.kind === "failed") {
    clearPipeline(body.runId)
  }

  // Step transitions are now fully managed by the server-side pipeline
  // (updatePipelineProgress sets stepTransition based on actual tool execution)

  const response = mapNormalizedResponseToClient(body.runId, normalized)

  if (response.status === "completed" || response.status === "failed") {
    if (response.status === "completed") {
      await finalizeTask(run.taskId, response as never)
      await finalizeRun(body.runId, response as never)
      await maybeUpdateProjectMemory({
        runId: body.runId,
        projectId: run.projectId,
        command: run.command as string | undefined,
        sysbasePath: run.sysbasePath as string | undefined
      })
    }

    const runLog = getRunActions(body.runId)
    await saveSessionEntry(run.projectId, {
      runId: body.runId,
      prompt: run.content,
      model: run.model,
      outcome: response.status,
      error: response.error || null,
      filesModified: runLog.filesModified,
      userId: run.userId || null,
      chatId: run.chatId || null
    })

    try {
      await autoSaveContext(run as unknown as RunRecord, runLog, response)
    } catch (err) {
      console.error("[context] Failed to auto-save context:", (err as Error).message)
    }

    clearRunActions(body.runId)
  }

  return response
}

// ─── Error enrichment: add recovery hints to tool errors before they reach the AI ───

function enrichSingleError(tool: string, result: Record<string, unknown>): Record<string, unknown> {
  const error = (result.error as string) || ""
  if (!error) return result

  // First: structured classification with rich hint (replaces the legacy regex chain).
  const classified = classifyToolError(tool, error)
  if (classified.category !== "unknown") {
    return {
      ...result,
      error: `${error}\n\n${classified.hint}`,
      _errorCategory: classified.category,
    }
  }

  // Fall back to the legacy hint table for anything the classifier marks unknown.
  const hint = getErrorRecoveryHint(tool, error)
  if (!hint) return result
  return { ...result, error: `${error}\n\n${hint}` }
}

function enrichErrorResults(results: Array<{ id: string; tool: string; result: Record<string, unknown> }>): Array<{ id: string; tool: string; result: Record<string, unknown> }> {
  return results.map((tr) => ({
    ...tr,
    result: enrichSingleError(tr.tool, tr.result)
  }))
}

function getErrorRecoveryHint(tool: string, error: string): string | null {
  const isEnoent = error.includes("ENOENT") || error.includes("no such file") || error.includes("cannot find")
  const isPermission = error.includes("EACCES") || error.includes("permission denied")
  const isNotExecutable = error.includes("could not determine executable") || error.includes("not recognized")

  if (isEnoent) {
    if (tool === "list_directory" || tool === "read_file" || tool === "batch_read") {
      return "⚠️ RECOVERY HINT: This file/directory does NOT exist. It was likely deleted or never created. Do NOT try to read it again. Instead, CREATE it from scratch using write_file or create_directory. If this was from a previous session, that work is gone — start fresh."
    }
    if (tool === "run_command") {
      return "⚠️ RECOVERY HINT: The directory in this command does not exist. If you need to cd into a project folder, you must scaffold/create it first. Do NOT assume previous session directories still exist."
    }
    return "⚠️ RECOVERY HINT: File/directory not found. Create it instead of trying to read it."
  }

  if (isNotExecutable) {
    return "⚠️ RECOVERY HINT: This command/package does not exist or has no executable. The command may be outdated (e.g., tailwindcss init was removed in v4). Skip this command and create the needed files manually with write_file."
  }

  if (isPermission) {
    return "⚠️ RECOVERY HINT: Permission denied. Try a different approach or skip this action."
  }

  return null
}

interface RunRecord {
  projectId: string
  userId?: string | null
  content: string
  sysbasePath?: string
  [key: string]: unknown
}

interface RunLog {
  actions: Array<Record<string, unknown>>
  filesModified: string[]
  errors: Array<{ tool: string; error: string; actionIndex: number }>
}

async function autoSaveContext(run: RunRecord, runLog: RunLog, response: ClientResponse): Promise<void> {
  const tags = extractSimpleTags(run.content)

  // Successful completion → save as candidate memory pattern
  if (response.status === "completed" && runLog.filesModified.length > 0) {
    await saveContext({
      projectId: run.projectId,
      userId: run.userId,
      category: "memory",
      title: run.content.slice(0, 100),
      content: `Task completed: "${run.content}". Files modified: ${runLog.filesModified.join(", ")}. Actions: ${runLog.actions.map((a) => a.tool).join(", ")}.`,
      tags,
      confidence: "medium",
      lifecycle: "candidate"
    })
  }

  // Failed task → save as verified bugfix pattern (we know the error is real)
  if (response.status === "failed" && response.error) {
    const fixContent = `Error: ${response.error.slice(0, 300)}\nTask: "${run.content}"\nActions attempted: ${runLog.actions.map((a) => a.tool + (a.path ? ` ${a.path}` : "")).join(", ")}`

    await saveContext({
      projectId: run.projectId,
      userId: run.userId,
      category: "bugfix_pattern",
      title: `Failed: ${run.content.slice(0, 80)}`,
      content: fixContent,
      tags,
      confidence: "high",
      lifecycle: "verified"
    })

    await writeFixFile(run, fixContent)
  }

  // Errors that were recovered from → high-value fix patterns
  const errors = runLog.errors || []
  if (response.status === "completed" && errors.length > 0) {
    for (const err of errors) {
      const fixContent = [
        `Error encountered: ${err.error}`,
        `Tool: ${err.tool}`,
        `Task: "${run.content}"`,
        `Resolution: The AI recovered and completed the task successfully.`,
        `Files modified: ${runLog.filesModified.join(", ") || "none"}`,
        ``,
        `LESSON: When you see this error, check the fix above. Do not repeat the same mistake.`
      ].join("\n")

      await saveContext({
        projectId: run.projectId,
        userId: run.userId,
        category: "bugfix_pattern",
        title: `Fixed: ${err.error.slice(0, 80)}`,
        content: fixContent,
        tags: [...tags, err.tool],
        confidence: "high",
        lifecycle: "verified"
      })

      await writeFixFile(run, fixContent)
    }
  }
}

async function writeFixFile(run: RunRecord, content: string): Promise<void> {
  try {
    if (!run.sysbasePath) return
    const fixesDir = path.join(run.sysbasePath, "fixes")
    await fs.mkdir(fixesDir, { recursive: true })

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
    const slug = (run.content || "fix").slice(0, 40).replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase()
    const filename = `${timestamp}_${slug}.md`

    await fs.writeFile(
      path.join(fixesDir, filename),
      `# Fix — ${new Date().toISOString()}\n\n${content}\n`,
      "utf8"
    )
    console.log(`[context] Wrote fix file: sysbase/fixes/${filename}`)
  } catch (err) {
    console.error("[context] Failed to write fix file:", (err as Error).message)
  }
}

function extractSimpleTags(prompt: string): string[] {
  if (!prompt) return []
  const stopWords = new Set([
    "the", "a", "an", "is", "are", "to", "of", "in", "for", "on", "with",
    "at", "by", "from", "as", "and", "or", "but", "not", "this", "that",
    "it", "i", "me", "my", "we", "you", "add", "create", "make", "use",
    "using", "please", "want", "need", "can", "will", "should"
  ])
  return prompt.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)
    .filter((w) => w.length > 2 && !stopWords.has(w)).slice(0, 8)
}
