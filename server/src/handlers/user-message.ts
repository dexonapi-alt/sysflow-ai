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
import { detectScaffoldingNeed, buildScaffoldConfirmationMessage } from "../scaffold/index.js"
import { estimateTokens, shouldBlockOnTokens } from "../services/context-budget.js"
import { runReasoning } from "../reasoning/task-reasoner.js"
import { recommendScaffold, resolveCommand, getInstallCommand } from "../scaffold/index.js"
import { recordImplementSummary, recordOriginalIntent } from "../memory-store/index.js"
import { recordChunkStart } from "../services/chunk-state.js"
import type { ChunkPlanBrief } from "../reasoning/reasoning-schema.js"
import { getFlag } from "../services/flags.js"
import { getConfidence, getThresholdState } from "../services/confidence-tracker.js"
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

  // ─── Phase 11 Stage 3: persist the LITERAL user prompt as `original_intent`
  // memory. The Phase 11 divergence detector reads this back so it compares
  // chunks against the user's actual ask, not the preflight brief's
  // interpretation. Best-effort; never blocks the run. Dedup is by content
  // hash so a repeat prompt is a no-op upsert.
  if (body.cwd) {
    recordOriginalIntent(body.cwd, body.content, { runId, trigger: "user_message" })
      .catch(() => { /* best-effort */ })
  }

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

  // ─── Phase 5 pre-flight reasoning: classify task, recommend stack, surface missing context ───
  let reasoningBrief: unknown = null
  try {
    const briefResult = await runReasoning({
      trigger: "preflight",
      userMessage: body.content,
      model: body.model,
      cwd: body.cwd,
      sysbasePath: body.sysbasePath,
    })
    reasoningBrief = briefResult
    // Phase 8: persist the implement brief if it's HIGH/MEDIUM confidence and decision === proceed.
    if (briefResult && briefResult.pipeline === "implement" && briefResult.decision === "proceed" && briefResult.confidence !== "LOW") {
      recordImplementSummary(
        body.cwd,
        { implementBrief: briefResult.implementBrief ?? undefined },
        { runId, trigger: "preflight" },
      ).catch(() => { /* best-effort */ })
    }
    // If the reasoner says ask_user, short-circuit immediately with the consolidated questions.
    if (briefResult && briefResult.pipeline !== "simple" && briefResult.decision === "ask_user" && briefResult.missingContext.length > 0) {
      const lines: string[] = []
      lines.push(`Before I start, I need a few things to avoid guessing:`)
      lines.push("")
      for (const m of briefResult.missingContext) {
        lines.push(`• **${m.field}** — ${m.suggestedQuestion}` + (m.exampleValue ? `\n   _e.g._ \`${m.exampleValue}\`` : ""))
      }
      lines.push("")
      if (briefResult.pipeline === "implement" && briefResult.implementBrief) {
        lines.push(`I'm planning to use **${briefResult.implementBrief.recommendedStack.language}**` +
          (briefResult.implementBrief.recommendedStack.frameworks.length ? ` + ${briefResult.implementBrief.recommendedStack.frameworks.join(" + ")}` : "") +
          ` — ${briefResult.implementBrief.recommendedStack.rationale}`)
      } else if (briefResult.pipeline === "bug" && briefResult.bugBrief) {
        lines.push(`I suspect a **${briefResult.bugBrief.suspectedBoundary}** issue — paste the requested context and I'll narrow it down.`)
      }
      console.log(`[reasoning] preflight ask_user with ${briefResult.missingContext.length} questions`)
      return {
        status: "waiting_for_user",
        runId,
        message: lines.join("\n"),
        reasoningBrief: briefResult,
      } as ClientResponse
    }
  } catch (err) {
    console.warn(`[reasoning] preflight failed:`, (err as Error).message)
  }

  // ─── Phase 10: chunked reasoning loop — first chunk-plan call.
  //
  // After preflight, when the implement intent is in play AND the chunked
  // loop is enabled, fire the FIRST chunk-plan call. The planner picks the
  // 1-5 files for the first chunk based on the implement brief; the result
  // gets stashed on the response (Stage 4 will inject it into the model
  // prompt so the main model honours the planner's file list).
  //
  // Trivial-task short-circuit: skip when the implement brief lists ≤3
  // build-plan steps — those tasks fit in one chunk anyway.
  let chunkPlanBrief: ChunkPlanBrief | null = null
  try {
    const chunkedLoopOn = getFlag<boolean>("reasoning.chunked_loop_enabled", body.sysbasePath)
    const briefPipeline = (reasoningBrief as { pipeline?: string } | null)?.pipeline
    const implementBrief = (reasoningBrief as { implementBrief?: { buildPlan?: unknown[] } } | null)?.implementBrief
    const buildPlanSteps = Array.isArray(implementBrief?.buildPlan) ? implementBrief!.buildPlan!.length : 0
    const isTrivial = buildPlanSteps > 0 && buildPlanSteps <= 3

    if (chunkedLoopOn && briefPipeline === "implement" && !isTrivial) {
      const planResult = await runReasoning({
        trigger: "chunk_plan",
        userMessage: body.content,
        model: body.model,
        cwd: body.cwd,
        sysbasePath: body.sysbasePath,
        context: {
          originalUserPrompt: body.content,
          implementBrief: implementBrief ?? null,
          chunkHistory: [],
        },
      })
      if (planResult?.chunkPlanBrief) {
        chunkPlanBrief = planResult.chunkPlanBrief
        // Initialise executedFiles with the planner's intent. Stage 4 will
        // refine this once the main model actually executes the chunk.
        recordChunkStart(runId, chunkPlanBrief, [...chunkPlanBrief.files])
        console.log(`[chunked-loop] chunk 0 planned: ${chunkPlanBrief.nextAction} (${chunkPlanBrief.files.length} files)`)
      }
    }
  } catch (err) {
    console.warn(`[chunked-loop] initial chunk_plan failed:`, (err as Error).message)
  }

  // ─── Phase 6 scaffold-first: when reasoning is HIGH confidence on a known stack and cwd is empty,
  // skip the model call entirely and emit the scaffolder run_command directly. ───
  try {
    const briefAny = reasoningBrief as never as Parameters<typeof recommendScaffold>[0]["brief"]
    const recommendation = recommendScaffold({
      brief: briefAny,
      userMessage: body.content,
      cwd: body.cwd,
      directoryTree: body.directoryTree as never,
    })
    if (recommendation.shouldScaffold && recommendation.autoTrust && recommendation.scaffolder) {
      const scaffoldCmd = resolveCommand(recommendation.scaffolder, recommendation.projectName)
      const installCmd = getInstallCommand(recommendation.scaffolder, recommendation.projectName)
      console.log(`[scaffold-first] auto-trust ${recommendation.scaffolder.stackKey}: ${scaffoldCmd} (note: simple stacks like Vite-family have autoTrust=false and fall through to hand-writing)`)

      // Inject post-scaffold guidance so the agent knows what to do after the command returns.
      const postScaffoldNote = recommendation.scaffolder.postScaffoldNote
      const followUpLines: string[] = []
      followUpLines.push(`[SCAFFOLD COMPLETE] You scaffolded "${recommendation.projectName}" using ${recommendation.scaffolder.displayName}.`)
      followUpLines.push(`The scaffolder created the standard file layout — DO NOT recreate files it already produced. Read package.json first to see what's there.`)
      if (installCmd) {
        followUpLines.push(`Next: run \`${installCmd}\` to install deps. The permission system will ask the user once.`)
      }
      if (postScaffoldNote) followUpLines.push(`NOTE: ${postScaffoldNote}`)
      followUpLines.push(`Then customise the scaffold for the user's actual task: "${body.content}".`)
      actionPlanner.injectContext(runId, followUpLines.join("\n"))

      // Synthesize the scaffold action as the agent's first response.
      const synthesizedNormalized: NormalizedResponse = {
        kind: "needs_tool",
        tool: "run_command",
        args: { command: scaffoldCmd, cwd: "." },
        content: `Scaffolding ${recommendation.scaffolder.displayName} into ./${recommendation.projectName}`,
        reasoning: `HIGH-confidence single registry match for ${recommendation.scaffolder.stackKey}; running the scaffolder beats hand-writing config files.`,
        usage: { inputTokens: 0, outputTokens: 0 },
      }
      const clientResp = mapNormalizedResponseToClient(runId, synthesizedNormalized)
      clientResp.reasoningBrief = reasoningBrief
      return clientResp
    }
  } catch (err) {
    console.warn(`[scaffold-first] recommender failed:`, (err as Error).message)
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
    reasoningBrief,
    chunkPlanBrief,
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

  // ─── Task Pipeline: only render the box when the AI itself produced a plan.
  // No more canned "Setup project / Implement features / Polish & finalize"
  // fallback — if the AI didn't generate a taskPlan that's its signal that
  // the task doesn't need one, and the agent's tool stream + final summary
  // cover the visible feedback. (Closes #12.)
  if (normalized.kind === "needs_tool" && normalized.taskPlan && normalized.taskPlan.steps.length > 0) {
    let pipelinePrompt = body.content
    const isContinue = /^\s*(continue|go on|keep going|next|proceed|finish)\s*$/i.test(body.content.trim()) || body.command === "/continue"
    if (isContinue && lastSession) {
      pipelinePrompt = lastSession.prompt || body.content
      console.log(`[task-pipeline] Using original prompt for /continue pipeline: "${pipelinePrompt.slice(0, 80)}"`)
    }
    const pipeline = createPipelineFromAiPlan(runId, pipelinePrompt, normalized.taskPlan)
    normalized.task = pipelineToTaskMeta(pipeline)
  }

  const clientResp = mapNormalizedResponseToClient(runId, normalized)
  if (reasoningBrief) clientResp.reasoningBrief = reasoningBrief
  // Phase 10: surface the chunk-plan brief on the response so the CLI (Stage 5)
  // can render the chunk progress badge. Stage 4 will also inject it into the
  // provider prompt so the model honours the planner's file list.
  if (chunkPlanBrief) (clientResp as unknown as Record<string, unknown>).chunkPlanBrief = chunkPlanBrief

  // Phase 11 Stage 5: emit a fresh awarenessSnapshot on the initial turn so
  // the CLI sees the badge from chunk 1 onwards. State is always on_track
  // here (the run just started), but consistency lets the cli use the
  // presence/absence of the field as the awareness-on signal.
  try {
    if (getFlag<boolean>("awareness.enabled", body.sysbasePath)) {
      ;(clientResp as unknown as Record<string, unknown>).awarenessSnapshot = {
        state: getThresholdState(runId, body.sysbasePath, body.model),
        confidence: getConfidence(runId),
        lastSignal: null,
      }
    }
  } catch {
    /* best-effort */
  }
  return clientResp
}
