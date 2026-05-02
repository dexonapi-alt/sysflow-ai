import crypto from "node:crypto"
import { createTask } from "../services/task.js"
import { loadProjectContext } from "../services/context.js"
import { saveRun } from "../store/runs.js"
import { persistModelUsage } from "../store/usage.js"
import { buildSessionSummary, getLastSession, saveOrphanedSessions, buildContinueContext } from "../store/sessions.js"
import { buildContextForPrompt, deprecateStaleEntries } from "../store/context.js"
import { callModelAdapter } from "../providers/adapter.js"
import { mapNormalizedResponseToClient } from "../providers/normalize.js"
import { analyzeTaskComplexity } from "../services/completion-guard.js"
import { actionPlanner } from "../services/action-planner.js"
import { initRunContext, ingestDirectoryTree } from "../services/context-manager.js"
import { isFrontendTask, detectFrontendStack, getFrontendPatterns } from "../knowledge/frontend-patterns.js"
import { accumulateFrontendContent } from "../services/frontend-quality-guard.js"
import { detectErrorForSearch, buildErrorSearchOverride } from "../services/setup-intelligence.js"
import { detectErrorContext, setPendingError, detectAllErrors, setPendingErrorQueue } from "../services/error-autofix.js"
import { createPipelineFromAiPlan, createFallbackPipeline, pipelineToTaskMeta } from "../services/task-pipeline.js"
import { detectScaffoldingNeed, buildScaffoldConfirmationMessage } from "../services/scaffold-options.js"
import { estimateTokens, shouldBlockOnTokens } from "../services/context-budget.js"
import type { ClientResponse, NormalizedResponse } from "../types.js"

interface UserMessageBody {
  projectId: string
  model: string
  content: string
  command?: string
  cwd: string
  sysbasePath?: string
  directoryTree?: Array<{ name: string; type: string }>
  userId?: string | null
  chatId?: string | null
  planMode?: boolean
}

export async function handleUserMessage(body: UserMessageBody): Promise<ClientResponse> {
  const runId = crypto.randomUUID()
  const taskId = crypto.randomUUID()

  await saveOrphanedSessions(body.projectId, body.chatId)

  const task = await createTask({
    taskId,
    runId,
    prompt: body.content,
    command: body.command,
    model: body.model,
    projectId: body.projectId
  })

  const context = await loadProjectContext({
    projectId: body.projectId,
    command: body.command,
    prompt: body.content,
    model: body.model,
    cwd: body.cwd,
    sysbasePath: body.sysbasePath,
    task
  }) as Record<string, unknown>

  const sessionSummary = await buildSessionSummary(body.projectId, body.chatId)
  if (sessionSummary) {
    // ─── Fresh-start detection: filter stale session references ───
    const currentFiles = (body.directoryTree || []).map((e) => e.name)
    const hasScaffoldedContent = currentFiles.length > 2 // more than just config files

    if (!hasScaffoldedContent && sessionSummary.includes("write_file")) {
      // Old sessions reference files that no longer exist — this is a fresh start
      context.sessionHistory = `⚠️ FRESH START DETECTED: Previous session data references files that no longer exist in this directory. The project was deleted or reset.\n\nCurrent directory contains: ${currentFiles.length > 0 ? currentFiles.join(", ") : "(empty)"}\n\nIMPORTANT: Ignore all previous file references. Start the task from scratch. Do NOT try to read, scan, or list directories from previous sessions — they do not exist. Create everything fresh.`
    } else {
      context.sessionHistory = sessionSummary
    }
  }

  const projectContext = await buildContextForPrompt(body.projectId, body.content)
  if (projectContext) {
    context.projectKnowledge = projectContext
  }

  // ─── Smart context loading: not just for /continue ───
  // Load continuation context when:
  // 1. Explicit /continue command
  // 2. New prompt that looks like a fix/debug request for the same project
  // 3. New prompt in a chat that has recent sessions (project already in progress)

  const isExplicitContinue = body.command === "/continue"
  const isFixRequest = /\b(fix|error|bug|issue|broken|wrong|fail|crash|not working|doesn't work|doesn't compile)\b/i.test(body.content)
  const isFollowUp = /\b(what'?s?\s*(the\s+)?(missing|wrong|left|remaining|incomplete|next)|missing\s+implementation|what\s+did\s+(i|you|we)\s+miss|check\s+(the\s+)?(status|progress)|review|improve|update|change|modify|add\s+to|enhance)\b/i.test(body.content)
  const lastSession = await getLastSession(body.projectId, body.chatId)
  const hasRecentWork = lastSession && lastSession.filesModified.length > 0

  if (isExplicitContinue || ((isFixRequest || isFollowUp) && hasRecentWork) || (hasRecentWork && body.chatId)) {
    const continueCtx = await buildContinueContext(body.projectId, body.chatId)
    if (continueCtx) {
      const currentFiles = (body.directoryTree || []).map((e) => e.name)
      if (currentFiles.length <= 2 && continueCtx.includes("Files already created:")) {
        context.continueContext = `⚠️ FRESH START: Previous files were deleted. Start from scratch. Current directory: ${currentFiles.join(", ") || "(empty)"}`
      } else {
        context.continueContext = continueCtx
      }
    }

    if (lastSession) {
      context.continueFrom = lastSession
    }

    if (isFixRequest && !isExplicitContinue) {
      context.continueContext = (context.continueContext || "") +
        `\n\n═══ FIX REQUEST CONTEXT ═══\nThe user is asking you to fix an error in the project you previously built. Use the continuation context above to understand what was created. Read the affected files, fix the issue, and continue completing any unfinished work from the original task.`
    }

    if (isFollowUp && !isFixRequest && !isExplicitContinue) {
      context.continueContext = (context.continueContext || "") +
        `\n\n═══ FOLLOW-UP CONTEXT ═══\nThe user is asking about work you already started. Use the continuation context above. Work in the SAME directory as the previous session — do NOT scaffold a new project or switch to a different directory.`
    }
  }

  await saveRun({
    runId,
    taskId,
    projectId: body.projectId,
    model: body.model,
    content: body.content,
    command: body.command,
    cwd: body.cwd,
    sysbasePath: body.sysbasePath,
    userId: body.userId || null,
    chatId: body.chatId || null,
    status: "running"
  })

  // ─── Initialize smart context manager for this run ───
  initRunContext(runId, body.content)
  if (body.directoryTree && body.directoryTree.length > 0) {
    ingestDirectoryTree(runId, body.directoryTree)
  }

  // ─── Deprecate stale context entries (cheap, runs once per new prompt) ───
  deprecateStaleEntries(body.projectId, 30).catch(() => { /* non-blocking */ })

  // ─── Scaffolding Confirmation: ask user before scaffolding ───
  const scaffoldOptions = detectScaffoldingNeed(body.content, body.directoryTree || [])
  if (scaffoldOptions) {
    console.log(`[scaffold] Detected new project — presenting ${scaffoldOptions.length} scaffolding options to user`)

    // Scaffold confirmation — pipeline created later when AI responds with its plan
    return {
      status: "waiting_for_user",
      runId,
      content: buildScaffoldConfirmationMessage(scaffoldOptions),
    } as ClientResponse
  }

  // ─── Frontend Design Intelligence: inject patterns when frontend work is detected ───
  if (isFrontendTask(body.content)) {
    const stack = detectFrontendStack(body.content, body.directoryTree)
    if (stack) {
      const patterns = getFrontendPatterns(stack, body.content)
      context.frontendPatterns = patterns
      console.log(`[frontend-design] Detected frontend task (stack: ${stack}) — injecting prompt-aware design brief`)
    }
  }

  // ─── Error-Aware Fix: parse error, search for file first, then read + guide the AI ───
  const errorCtx = detectErrorContext(body.content)
  if (errorCtx) {
    const ctx = errorCtx.ctx
    const fileName = ctx.sourceFile.split("/").pop() || ctx.sourceFile
    const baseName = fileName.replace(/\.[^.]+$/, "")
    console.log(`[error-aware] Detected fixable error: "${ctx.description}" — searching for "${baseName}" first`)
    setPendingError(runId, ctx)

    // Detect ALL errors from the prompt and queue remaining ones for sequential fixing
    const allErrors = detectAllErrors(body.content)
    if (allErrors.length > 1) {
      // Queue all errors except the first (which we're handling now)
      const remaining = allErrors.filter(e => !(e.sourceFile === ctx.sourceFile && e.targetImport === ctx.targetImport))
      if (remaining.length > 0) {
        setPendingErrorQueue(runId, remaining)
        console.log(`[error-aware] Queued ${remaining.length} additional error(s) for sequential fixing`)
      }
    }

    // Pass all detected errors to the pipeline for specific step labels
    const allErrorsForPipeline = allErrors.length > 0
      ? allErrors.map(e => ({ sourceFile: e.sourceFile, targetImport: e.targetImport }))
      : [{ sourceFile: ctx.sourceFile, targetImport: ctx.targetImport }]
    const pipeline = createFallbackPipeline(runId, body.content, allErrorsForPipeline)

    // Always search first — never guess the extension
    const searchAction: NormalizedResponse = {
      kind: "needs_tool",
      tool: "search_files",
      args: { query: baseName, glob: `**/${baseName}.*` },
      content: `Searching for "${baseName}" to find its actual path and extension.`,
      reasoning: `The error references "${ctx.sourceFile}" but the extension may differ. Searching to find the real file.`,
      usage: { inputTokens: 0, outputTokens: 0 },
      task: pipelineToTaskMeta(pipeline)
    }

    return mapNormalizedResponseToClient(runId, searchAction)
  }

  // ─── Pre-API token guard: refuse oversized payloads instead of wasting an API call ───
  const estimatedTokens =
    estimateTokens(body.content) +
    estimateTokens(body.directoryTree) +
    estimateTokens(context.sessionHistory) +
    estimateTokens(context.projectMemory) +
    estimateTokens(context.projectKnowledge) +
    estimateTokens(context.frontendPatterns) +
    estimateTokens(context.continueContext)
  if (shouldBlockOnTokens(estimatedTokens, body.model)) {
    console.warn(`[token-guard] BLOCKED: estimated ${estimatedTokens} tokens exceeds ${body.model} effective window`)
    return {
      status: "failed",
      runId,
      error: `Prompt too long (~${estimatedTokens} tokens). Try a shorter prompt or fewer @file mentions.`,
      errorCode: "prompt_too_long",
    } as ClientResponse
  }

  let normalized = await callModelAdapter({
    model: body.model,
    runId,
    task: task as never,
    context: context as never,
    userMessage: body.content,
    command: body.command,
    directoryTree: (body.directoryTree || []) as never,
    projectId: body.projectId,
    cwd: body.cwd,
    planMode: body.planMode === true,
    userId: body.userId || null,
    chatId: body.chatId || null
  } as never)

  await persistModelUsage({
    runId,
    projectId: body.projectId,
    model: body.model,
    usage: normalized.usage,
    userId: body.userId || null,
    isNewPrompt: true
  })

  // ─── Forced reconnaissance: tell planner if this is an existing project ───
  const nonSysbaseFiles = (body.directoryTree || []).filter((e) => !e.name.startsWith("sysbase"))
  const hasExistingProject = nonSysbaseFiles.length > 2
  actionPlanner.setHasExistingProject(runId, hasExistingProject)

  // Action planner: fix broken tools, detect loops, enforce reconnaissance
  normalized = actionPlanner.intercept(runId, normalized)

  // ─── Setup Intelligence: if user reported an error, force web search for the fix ───
  const detectedError = detectErrorForSearch(body.content)
  if (detectedError && normalized.tool !== "web_search") {
    console.log(`[setup-intelligence] Error detected in prompt (${detectedError.errorType}) — overriding to web_search: "${detectedError.searchQuery}"`)
    normalized = buildErrorSearchOverride(detectedError)
  }

  // Accumulate frontend content for quality analysis
  if (isFrontendTask(body.content)) {
    accumulateFrontendContent(runId, normalized)
  }

  // Layer 3: Guard against AI completing on the FIRST call (before any tools run)
  const analysis = analyzeTaskComplexity(body.content)
  if (normalized.kind === "completed") {
    if (analysis.complexity !== "simple") {
      console.log(`[user-message] AI tried to complete ${analysis.complexity} task on first call — overriding to needs_tool`)
      normalized.kind = "needs_tool"
      normalized.tool = "list_directory"
      normalized.args = { path: "." }
      normalized.content = "Starting implementation..."
      normalized.reasoning = "I need to implement the full task, not just respond with a summary."
    }
  }

  // ─── AI-Driven Planning: for complex tasks, force the AI to present a plan ───
  // If the AI's first response is a write/edit (not a read), and the task is complex,
  // inject a planning directive so the AI outputs a plan for user confirmation.
  if (analysis.complexity !== "simple" && normalized.kind === "needs_tool") {
    const firstTool = normalized.tool || ""
    const isAlreadyReading = ["read_file", "batch_read", "list_directory", "search_code", "search_files", "web_search"].includes(firstTool)

    if (!isAlreadyReading) {
      // Override: force the AI to read first, then on next turn it'll get a planning directive
      console.log(`[user-message] Complex task — forcing AI to read project before implementing`)
      normalized.tool = "list_directory"
      normalized.args = { path: "." }
      normalized.tools = undefined
      normalized.content = "Reading project structure to plan implementation..."
    }
  }

  // ─── Task Pipeline: use AI's plan if provided, otherwise fallback ───
  if (normalized.kind === "needs_tool") {
    let pipelinePrompt = body.content
    const isContinue = /^\s*(continue|go on|keep going|next|proceed|finish)\s*$/i.test(body.content.trim()) || body.command === "/continue"
    if (isContinue && lastSession) {
      pipelinePrompt = lastSession.prompt || body.content
      console.log(`[task-pipeline] Using original prompt for /continue pipeline: "${pipelinePrompt.slice(0, 80)}"`)
    }

    if (normalized.taskPlan && normalized.taskPlan.steps.length > 0) {
      const pipeline = createPipelineFromAiPlan(runId, pipelinePrompt, normalized.taskPlan)
      normalized.task = pipelineToTaskMeta(pipeline)
    } else {
      const pipeline = createFallbackPipeline(runId, pipelinePrompt)
      normalized.task = pipelineToTaskMeta(pipeline)
    }
  }

  return mapNormalizedResponseToClient(runId, normalized)
}
