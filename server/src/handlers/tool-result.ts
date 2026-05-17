import fs from "node:fs/promises"
import path from "node:path"
import { getRun, finalizeRun } from "../store/runs.js"
import { getTask, finalizeTask } from "../store/tasks.js"
import { saveToolResult } from "../store/tool-results.js"
import { collectStrippedImports, buildImportStrippedInject } from "../services/import-stripped-inject.js"
import { runTscGate, buildTscFailedInject } from "../services/tsc-completion-gate.js"
import { checkImpliedArtifacts, buildArtifactMissingInject } from "../services/completion-artifact-gate.js"
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
import { ingestToolResult, ingestDirectoryTree, clearRunContext, buildWorkingContextString } from "../services/context-manager.js"
import { updatePipelineProgress, completePipeline, clearPipeline, getPipeline, hasPipeline, pipelineToTaskMeta, createPipelineFromAiPlan } from "../services/task-pipeline.js"
import { getScaffoldChoice, storeScaffoldChoice, parseScaffoldResponse, clearScaffoldState } from "../scaffold/index.js"
import { getPendingError, clearPendingError, setPendingError, buildFixInstructions, setPendingFileContent, hasPendingErrors, popNextPendingError } from "../services/error-autofix.js"
import { applyToolResultBudget, estimateTokens, shouldBlockOnTokens } from "../services/context-budget.js"
import { classifyToolError, classifyToolErrorFromResult } from "../services/tool-error-classifier.js"
import { persistLargeToolResult } from "../store/tool-result-persistence.js"
import { runReasoning, getReasonerBackendForRun, clearReasonerBackendForRun } from "../reasoning/task-reasoner.js"
import { runErrorReasoningChain } from "../reasoning/error-reasoner.js"
import { validateErrorAcknowledgement, buildErrorAcknowledgementRejectPrompt, primaryArg } from "../services/error-acknowledgement-guard.js"
import { recordImplementSummary, recordBugPattern, recordChunkSummary, recordUserCorrection, applyMemoryFeedback, recallForReasoning, recallErrorPatterns, recordErrorPattern, formatRecallForReasoner } from "../memory-store/index.js"
import {
  attachReflection,
  recordChunkStart,
  getLatestChunk,
  getChunkHistory,
  chunkCount as chunkStateCount,
  clearChunkState,
} from "../services/chunk-state.js"
import type { ChunkPlanBrief, ChunkReflectionBrief } from "../reasoning/reasoning-schema.js"
import { getFlag } from "../services/flags.js"
import { detectDivergence, pickDivergenceAnchor, type DetectorInput } from "../services/divergence-detector.js"
import { isSafeReadOnlyCommand } from "../services/safe-commands.js"
import { applyLedgerUpdates, clearLedger } from "../services/task-ledger.js"
import { clearReviewState } from "../services/self-review-scheduler.js"
import { getLastReasoning, setLastReasoning, clearLastReasoning } from "../services/last-reasoning-store.js"
import { pickLastReasoning } from "../services/reasoner-action-checker.js"
import { shouldRunDivergenceSecondLook, resolveMaxChunksPerRun, resolveMaxFilesPerChunk, shouldRunPerStepDivergence, getInvestigationBudget } from "../services/free-tier-policy.js"
import { classifyIntent, getCachedIntentOrRegex } from "../reasoning/intent-classifier.js"
import { clearIntentForRun } from "../services/intent-cache.js"
import { recordSignals as recordConfidenceSignals, clearConfidence, getConfidence, getConfidenceState, getThresholdState } from "../services/confidence-tracker.js"
import { runVerificationGate, gateSignals } from "../services/verification-gate.js"
import type { ClientResponse, NormalizedResponse } from "../types.js"

/** Track how many times completion was rejected per run (prevent infinite loops) */
const completionRejections = new Map<string, number>()
const MAX_COMPLETION_REJECTIONS = 3

/** Phase 5: per-run consecutive-error counter + on-error reasoning budget. */
const consecutiveToolErrors = new Map<string, number>()
const onErrorReasoningCount = new Map<string, number>()
const MAX_ON_ERROR_REASONING_PER_RUN = 2

/** Stage 4 of forced-error-reasoning plan: per-run count of
 *  error-acknowledgement rejections. Hard cap (3) prevents infinite
 *  loops if the model never acknowledges. Mirrors the
 *  completionRejections shape. */
const errorAcknowledgementRejections = new Map<string, number>()
const MAX_ERROR_ACK_REJECTIONS = 3

/** Stage 5: per-run state tracking an in-flight error → recovery
 *  sequence. Set when a tool errors, then consumed on the NEXT
 *  tool-result call: if that call has no error AND the agent's most
 *  recent attempt used the same tool kind with different args, the
 *  recovery is recorded as an `error_pattern` memory entry. Cleared on
 *  successful recording OR on terminal run exit. */
interface PendingErrorRecovery {
  errorText: string
  errorClass: string
  platform: string
  failedTool: string
  failedCommand: string
  /** Args the agent emitted in response to the error — captured at the
   *  end of THIS handler call so the next call (which sees success)
   *  knows what the agent attempted. */
  attemptedTool?: string
  attemptedArgs?: Record<string, unknown>
}
const pendingErrorRecovery = new Map<string, PendingErrorRecovery>()

/** Track frontend quality rejections per run (separate from structural completion guard) */
const frontendQualityRejections = new Map<string, number>()
const MAX_FRONTEND_QUALITY_REJECTIONS = 2

/** Phase 11 Stage 3: chunk index when the LLM divergence pipeline last fired
 *  for a given run. Used to enforce "every 2nd chunk" cadence — combined with
 *  the heuristic-fired trigger so the LLM half can fire ad-hoc too. */
const lastLlmDivergenceCheckedChunk = new Map<string, number>()
/** Hard cap on LLM divergence calls per run, even if heuristics keep firing. */
const MAX_LLM_DIVERGENCE_PER_RUN = 8

/** Phase 11 Stage 4: chunks remaining in the post-pause cooldown. After the
 *  user resolves an off-course modal (continue / backtrack / redirect), we
 *  mute the awareness loop for N more chunks so a `continue the task` request
 *  doesn't immediately re-fire the same modal. Decrements per chunk; cleared
 *  on terminal exit. */
const awarenessCooldownChunks = new Map<string, number>()
const POST_RESOLUTION_COOLDOWN_CHUNKS = 2

/** Phase 11 Stage 4: cache the last LLM divergence verdict per run so the
 *  off-course modal can render its mismatches alongside the heuristic
 *  signals. */
const lastDivergenceVerdict = new Map<string, { mismatches: string[]; suggestion: "continue" | "pause" | "backtrack"; score: number }>()

interface ToolResultBody {
  runId: string
  tool: string
  result: Record<string, unknown>
  toolResults?: Array<{ id: string; tool: string; result: Record<string, unknown> }>
  planMode?: boolean
  /** Stage 4 of agent-runtime-fixes plan: fresh top-level directory
   *  tree the cli captured AFTER the just-executed tool batch. Present
   *  only when the batch contained mutating tools (write_file /
   *  edit_file / delete_file / create_directory / batch_write /
   *  run_command). Used to detect stale file references the agent may
   *  hallucinate from prior turns. */
  directoryTree?: Array<{ name: string; type: "file" | "directory" }>
}

export async function handleToolResult(body: ToolResultBody): Promise<ClientResponse> {
  const isBatch = body.toolResults && body.toolResults.length > 0

  // Stage 1 of plan 2026-05-16-server-hardening-and-error-source-distinction.md:
  // reject payloads with null / empty tool names BEFORE the persist path.
  // The DB schema enforces tool NOT NULL (migration 011); without this
  // gate a null tool causes a Postgres constraint-violation 500 that
  // surfaces as a raw error to the user. The cli's `isKnownTool` gate
  // (executor.ts) catches these client-side, but this guard is
  // belt-and-suspenders for any direct API call / test / external
  // integration that might bypass the cli.
  if (isBatch) {
    const hasInvalid = body.toolResults!.some((tr) => typeof tr.tool !== "string" || tr.tool.length === 0)
    if (hasInvalid && body.toolResults!.every((tr) => typeof tr.tool !== "string" || tr.tool.length === 0)) {
      // ALL tools invalid — reject the whole batch.
      console.warn(`[tool-result] BLOCKED batch payload — all tool names null/empty (runId=${body.runId})`)
      return {
        status: "failed",
        runId: body.runId,
        error: "Tool name required on every tool result. Got null/empty.",
        errorCode: "malformed_response",
      } as ClientResponse
    }
    // Mixed: continue, but the saveToolResult guard will skip the null rows.
  } else {
    if (typeof body.tool !== "string" || body.tool.length === 0) {
      console.warn(`[tool-result] BLOCKED single payload — null/empty tool name (runId=${body.runId})`)
      return {
        status: "failed",
        runId: body.runId,
        error: "Tool name required. Got null/empty.",
        errorCode: "malformed_response",
      } as ClientResponse
    }
  }

  // We need the run's sysbasePath for archival — fetch it ahead of save.
  let sysbasePath: string | undefined
  try {
    const r = await getRun(body.runId)
    sysbasePath = r.sysbasePath as string | undefined
  } catch {
    sysbasePath = undefined
  }

  // ─── Tool-result archival + budget ───
  // 1) Archive the *original* (pre-budget) result to disk if it's large
  //    (>10 KiB serialised). 2) Then clamp the in-memory representation
  //    via applyToolResultBudget. The model only sees the clamped view,
  //    but a human can inspect the full result later.
  if (isBatch) {
    const enriched: typeof body.toolResults = []
    for (const tr of body.toolResults!) {
      const archive = await persistLargeToolResult({ sysbasePath, runId: body.runId, toolId: tr.id, tool: tr.tool, result: tr.result })
      const clamped = applyToolResultBudget(tr.tool, tr.result)
      if (archive.path) {
        clamped._persistedPath = archive.path
        clamped._persistedSize = archive.originalSize
      }
      enriched!.push({ ...tr, result: clamped })
    }
    body.toolResults = enriched
    for (const tr of body.toolResults!) {
      await saveToolResult(body.runId, tr.tool, tr.result)
    }
  } else {
    const archive = await persistLargeToolResult({ sysbasePath, runId: body.runId, toolId: "single", tool: body.tool, result: body.result })
    body.result = applyToolResultBudget(body.tool, body.result)
    if (archive.path) {
      body.result._persistedPath = archive.path
      body.result._persistedSize = archive.originalSize
    }
    await saveToolResult(body.runId, body.tool, body.result)
  }

  // Stage 2 of plan 2026-05-16-agent-code-correctness-and-completion-artifacts.md:
  // surface import-sanitizer strips as a LOUD inject to the agent's
  // next turn. Previously the cli stripped silently — agent wrote a
  // file referencing names whose imports were gone, never knew, hit
  // ReferenceError at runtime later. Now: per-file strips collected
  // from each tool result, single inject block listing them with
  // recovery instructions. One-shot (consumed on next adapter call).
  const strippedResults = isBatch
    ? body.toolResults!.map((tr) => ({ tool: tr.tool, result: tr.result }))
    : [{ tool: body.tool, result: body.result }]
  const stripped = collectStrippedImports(strippedResults)
  if (stripped.length > 0) {
    const totalCount = stripped.reduce((sum, s) => sum + s.imports.length, 0)
    actionPlanner.injectContext(body.runId, buildImportStrippedInject(stripped))
    console.log(`[import-sanitizer-inject] ${totalCount} stripped import(s) across ${stripped.length} file(s) — injected loud feedback for next turn`)
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

  // ─── Phase 11 Stage 4: off-course resolution ───
  // The cli routes the user's answer back as `_user_response` with kind=off_course.
  // Apply the action's state mutations, then fall through so the rest of
  // handleToolResult drives the next step normally (the injected planner
  // context steers the next chunk).
  if (
    body.tool === "_user_response"
    && (body.result as Record<string, unknown>)?.kind === "off_course"
  ) {
    const action = (body.result as Record<string, unknown>).action as "continue" | "backtrack" | "redirect"
    const text = (body.result as Record<string, unknown>).text as string | null | undefined
    const lastGoodChunkIndex = (body.result as Record<string, unknown>).lastGoodChunkIndex as number | undefined
    console.log(`[awareness] off-course resolution: action=${action}`)

    // All three actions reset the awareness state and start the cooldown
    // so the user's choice doesn't immediately re-trigger the modal.
    clearConfidence(body.runId)
    awarenessCooldownChunks.set(body.runId, POST_RESOLUTION_COOLDOWN_CHUNKS)
    lastDivergenceVerdict.delete(body.runId)
    lastLlmDivergenceCheckedChunk.delete(body.runId)

    if (action === "backtrack" || action === "redirect") {
      // Drop chunk-state + pipeline so the next call re-plans from scratch.
      // The disk has been rolled back (cli-side) for backtrack; for redirect
      // the user is supplying new direction — either way the prior chunk
      // history is no longer authoritative.
      clearChunkState(body.runId)
      clearPipeline(body.runId)
      const note = action === "backtrack"
        ? `[OFF-COURSE BACKTRACK] The user just rolled back chunk ${lastGoodChunkIndex ?? 0} after the awareness loop flagged the run as off-course. The disk has been restored to that snapshot. Re-plan from this point — read the current files first, then implement the original ask: "${run.content}".`
        : `[OFF-COURSE REDIRECT] The user just course-corrected the run. Their new direction: "${text ?? ""}". Drop everything you were doing and pivot. Original ask was: "${run.content}".`
      actionPlanner.injectContext(body.runId, note)

      // Phase 15 Stage 1: a redirect or backtrack IS a correction signal —
      // the agent's last direction was wrong enough that the user had to
      // intervene. Persist as a user_correction memory entry so the next
      // run on the same project can recall the prior course-correction
      // when it considers a similar approach.
      if (run.cwd) {
        const correctionText = action === "backtrack"
          ? `Backtracked chunk ${lastGoodChunkIndex ?? 0} after awareness flagged off-course on: "${run.content}"`
          : `Course-corrected: "${text ?? "(no text)"}" (original ask: "${run.content}")`
        recordUserCorrection(
          run.cwd as string,
          correctionText,
          { runId: body.runId, trigger: "off_course_resolution" },
        ).catch(() => { /* best-effort */ })
      }
    }

    // Rewrite body.result so downstream guards (the scaffold-choice probe
    // below + the per-tool error/lint checks) see a benign success record.
    body.result = { success: true, action, _resumedFromOffCourse: true } as Record<string, unknown>
  }

  // ─── Scaffold choice injection: when user responds to scaffold question, inject the command ───
  if (body.tool === "_user_response") {
    const userAnswer = (body.result.answer as string) || (body.result.content as string) || ""
    // Check if this looks like a scaffold choice response (number or keyword)
    if (/^\s*[1-9]\s*$/.test(userAnswer.trim()) || /\b(vite|next|nest|manual|create)\b/i.test(userAnswer)) {
      // Import scaffold options dynamically to parse the choice
      const { parseScaffoldResponse, detectScaffoldingNeed } = await import("../scaffold/index.js")
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

  // ─── Stage 5 of command-first-investigation: investigation-budget reminder ───
  // When the agent has run `getInvestigationBudget` worth of safe-read-only
  // commands without writing anything yet, inject a one-shot reminder telling
  // it to switch from investigation to action. Latched per-run so it fires
  // at most once; sustained over-investigation gets caught by the existing
  // `scope_creep` heuristic via the confidence tracker.
  maybeInjectInvestigationBudgetReminder(body.runId, run)

  // ─── Stage 4 of free-tier-quality-enforcement: per-step divergence ───
  // For free-tier runs, the lightweight HEURISTIC detector runs after every
  // tool result — not just at chunk boundaries. The LLM divergence pipeline
  // stays gated to the chunk-boundary block above (too expensive per-step).
  // The new `same_action_repeated_in_session` heuristic is the primary
  // payload here: it spots stuck-loops (same tool+path 3+ times in 6 turns)
  // MID-chunk so the off-course modal can fire before the agent burns another
  // 4 turns retrying the same broken edit. Gated by:
  //   - `awareness.enabled` (the umbrella switch — respect cooldowns too)
  //   - `quality.per_step_divergence_for_free_tier` (per-stage kill switch)
  //   - `shouldRunPerStepDivergence(model)` (free-tier only)
  try {
    const awarenessOn = getFlag<boolean>("awareness.enabled", run.sysbasePath as string | null | undefined)
    const perStepFlag = getFlag<boolean>("quality.per_step_divergence_for_free_tier", run.sysbasePath as string | null | undefined)
    const cooldownLeft = awarenessCooldownChunks.get(body.runId) ?? 0
    if (
      awarenessOn
      && perStepFlag
      && cooldownLeft === 0
      && shouldRunPerStepDivergence(run.model as string | null | undefined)
    ) {
      const input = buildDetectorInput(body.runId, run.content)
      let signals = detectDivergence(input)
      // Stage 5: per-heuristic kill switch for reasoning_action_mismatch.
      // Detector stays pure; caller filters.
      const crossCheckOn = (() => {
        try { return getFlag<boolean>("quality.reasoning_action_cross_check_enabled", run.sysbasePath as string | null | undefined) }
        catch { return true }
      })()
      if (!crossCheckOn) {
        signals = signals.filter((s) => s.category !== "reasoning_action_mismatch")
      }
      if (signals.length > 0) {
        recordConfidenceSignals(body.runId, signals)
        const score = getConfidence(body.runId)
        const state = getThresholdState(body.runId, run.sysbasePath as string | null | undefined, run.model as string | undefined)
        console.log(`[awareness] per-step: ${signals.length} signal(s), confidence=${score} state=${state} (categories: ${signals.map((s) => s.category).join(", ")})`)
      }
    }
  } catch (err) {
    console.warn(`[awareness] per-step divergence failed:`, (err as Error).message)
  }

  // ─── Phase 6: post-scaffold guidance — when a scaffolder run_command just succeeded,
  // inject a follow-up so the agent knows not to recreate the generated files and to install deps. ───
  if (!isBatch && body.tool === "run_command") {
    const cmd = (body.result.command as string) || ""
    const success = body.result.success !== false && !body.result.error && !body.result.skipped
    if (success && looksLikeScaffoldCommand(cmd)) {
      const projectName = extractScaffoldedDir(cmd) || "the new project"
      actionPlanner.injectContext(body.runId,
        `[POST-SCAFFOLD] The scaffolder finished. Files are in ./${projectName}.\n` +
        `1. DO NOT recreate package.json, tsconfig, vite.config, or any file the scaffolder produced.\n` +
        `2. Read the generated package.json first to see the actual stack + dep versions.\n` +
        `3. Run \`cd ${projectName} && npm install\` (or pnpm/yarn equivalent if the scaffolder used a different manager). The permission system will ask the user once.\n` +
        `4. Then customise the scaffold for the user's actual task — edit src files, don't recreate them.`
      )
      console.log(`[scaffold] post-scaffold guidance injected for ${projectName}`)
    }
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
    cwd: run.cwd as string | undefined,
    planMode: body.planMode === true,
    // onErrorBrief is set later in the on-error trigger block; initialise the field here
    // and let the on-error block patch it before the provider call (reasoningBrief is read
    // by buildPrompt which runs inside callModelAdapter).
    reasoningBrief: null as unknown,
    userId: run.userId || null,
    chatId: run.chatId || null,
    // Phase 18 Stage 5: thread the run's classified intent + complexity
    // so the system-rules section's taskPlan instruction stays
    // conditional on every turn (the model only sees the "include
    // taskPlan" rubric on the first response of implement-class
    // medium/complex runs).
    runIntent: getCachedIntentOrRegex(body.runId, run.content),
    taskComplexity: analyzeTaskComplexity(run.content).complexity,
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

  // ─── Phase 5: on-error reasoning trigger ───
  // Count consecutive errors in the incoming results; if ≥ 2 AND we haven't
  // exhausted the per-run reasoning budget, run the bug pipeline and inject
  // the brief into the next provider payload so the agent benefits.
  let onErrorBrief: unknown = null
  // Stage 3 of forced-error-reasoning plan: track the chain brief +
  // paragraphs so we can surface them on the client response.
  let errorReasoningChainBrief: import("../reasoning/error-reasoner.js").ErrorReasoningBrief | null = null
  let errorReasoningSource: "chain" | "bug_fallback" | null = null
  const incomingErrors = isBatch
    ? body.toolResults!.filter((tr) => (tr.result as Record<string, unknown>).error || (tr.result as Record<string, unknown>).success === false)
    : (body.result.error || body.result.success === false ? [{ id: "single", tool: body.tool, result: body.result }] : [])
  if (incomingErrors.length > 0) {
    const prev = consecutiveToolErrors.get(body.runId) ?? 0
    const next = prev + 1
    consecutiveToolErrors.set(body.runId, next)

    // ─── Stage 3 of forced-error-reasoning plan ───
    // Fire the LLM error-reasoning chain on EVERY error (not just
    // consecutive ≥ 2 like the bug pipeline). The chain's brief drives
    // the `═══ ERROR — REASON THROUGH THIS ═══` block injection at
    // the bottom of the next tool-result message body. The existing
    // bug pipeline below stays as the fallback when the chain
    // returns null (no backend / parse failure / cap without
    // commitment).
    const forceErrorReasoningEnabled = (() => {
      try { return getFlag<boolean>("quality.force_error_reasoning_enabled", run.sysbasePath as string | undefined) }
      catch { return true }
    })()
    if (forceErrorReasoningEnabled) {
      try {
        const lastError = incomingErrors[incomingErrors.length - 1]
        const errResultRecord = lastError.result as Record<string, unknown>
        const errText = typeof errResultRecord.error === "string"
          ? errResultRecord.error
          : typeof errResultRecord.stderr === "string"
          ? errResultRecord.stderr
          : "Tool reported failure (no error text)"
        const maxIters = (() => {
          try { return getFlag<number>("reasoning.error_reasoning_max_iterations", run.sysbasePath as string | undefined) }
          catch { return 4 }
        })()
        // ─── Stage 5: error_pattern recall ───
        // Before firing the chain, surface any prior recorded fix for
        // a similar error on this platform. The reasoner's user turn
        // then carries it as `priorRecall`, letting the chain confirm
        // or revise rather than re-deriving from scratch.
        let priorRecall: string | null = null
        const recallEnabled = (() => {
          try { return getFlag<boolean>("memory.error_pattern_recall_enabled", run.sysbasePath as string | undefined) }
          catch { return true }
        })()
        if (recallEnabled && run.cwd) {
          try {
            const matches = await recallErrorPatterns({
              cwd: run.cwd as string,
              errorSignature: errText,
              platform: process.platform,
              maxEntries: 3,
            })
            priorRecall = formatRecallForReasoner(matches)
            if (priorRecall) {
              console.log(`[error-pattern] recall surfaced ${matches.length} prior pattern(s) for ${process.platform}`)
            }
          } catch (recallErr) {
            console.warn(`[error-pattern] recall failed:`, (recallErr as Error).message)
          }
        }
        // Stash the failed command for the recovery recorder (consumed
        // on the NEXT tool-result call when no error fires). Only
        // run_command is tracked for v1 — write_file/edit_file paths
        // are too heterogeneous to mine reliably yet.
        if (lastError.tool === "run_command") {
          const failedArgs = (errResultRecord.args as Record<string, unknown> | undefined) ?? undefined
          const failedCommand = failedArgs && typeof failedArgs.command === "string" ? failedArgs.command : ""
          if (failedCommand) {
            pendingErrorRecovery.set(body.runId, {
              errorText: errText,
              errorClass: classifyToolError(lastError.tool, errText).category,
              platform: process.platform,
              failedTool: lastError.tool,
              failedCommand,
            })
          }
        }
        const chainBrief = await runErrorReasoningChain({
          errorText: errText,
          tool: lastError.tool,
          args: (errResultRecord.args as Record<string, unknown>) ?? undefined,
          platform: process.platform,
          model: run.model,
          maxIterations: maxIters,
          priorRecall,
        })
        if (chainBrief) {
          errorReasoningChainBrief = chainBrief
          errorReasoningSource = "chain"
          // Patch the provider payload so the inject block reads the
          // brief in buildToolResultMessage.
          ;(providerPayload as Record<string, unknown>).errorReasoningBrief = chainBrief
          ;(providerPayload as Record<string, unknown>).errorReasoningErrorText = errText
          ;(providerPayload as Record<string, unknown>).errorReasoningFailedTool = lastError.tool
          console.log(`[error-reasoner] chain committed (iterations=${chainBrief.iterations}, recommendation=${chainBrief.recommendedCommand})`)
        }
      } catch (err) {
        console.warn(`[error-reasoner] chain threw:`, (err as Error).message)
      }
    }

    const used = onErrorReasoningCount.get(body.runId) ?? 0
    // Existing bug pipeline runs as FALLBACK — only when the chain
    // didn't produce a brief AND the consecutive-error budget allows.
    // The chain catches the FIRST error; the bug pipeline persists a
    // `bug_pattern` memory entry on sustained failures, which we keep
    // for the memory-store integration Stage 5 will extend.
    if (!errorReasoningChainBrief && next >= 2 && used < MAX_ON_ERROR_REASONING_PER_RUN) {
      onErrorReasoningCount.set(body.runId, used + 1)
      try {
        const lastError = incomingErrors[incomingErrors.length - 1]
        const briefResult = await runReasoning({
          trigger: "on_error",
          userMessage: `Tool ${lastError.tool} failed: ${(lastError.result as Record<string, unknown>).error ?? "unspecified"}`,
          model: run.model,
          cwd: run.cwd as string | undefined,
          sysbasePath: run.sysbasePath as string | undefined,
          runId: body.runId,
          context: { tool: lastError.tool, result: lastError.result, recentErrors: incomingErrors.length },
        })
        onErrorBrief = briefResult
        if (briefResult) errorReasoningSource = "bug_fallback"
        // Patch the provider payload so the next model call sees the bug brief.
        ;(providerPayload as Record<string, unknown>).reasoningBrief = briefResult
        if (briefResult && briefResult.pipeline === "bug") {
          console.log(`[reasoning] on_error bug brief: ${briefResult.bugBrief?.suspectedBoundary}`)
          // Phase 8: persist the bug brief as a bug_pattern entry so future
          // runs see the diagnosis the next time the same symptom appears.
          if (briefResult.bugBrief) {
            const bb = briefResult.bugBrief
            const summary = [
              `Symptom: ${bb.symptom}`,
              `Boundary: ${bb.suspectedBoundary}`,
              bb.rootCauseGuess ? `Root cause: ${bb.rootCauseGuess}` : null,
              `Fix: ${bb.proposedFix?.description ?? "(none)"} (scope: ${bb.proposedFix?.scope ?? "?"})`,
            ].filter(Boolean).join("\n")
            // Phase 15 Stage 2: pass confidence so the recorder's internal
            // LOW-skip can drop a low-confidence diagnosis. The on-error
            // path used to record unconditionally; LOW-confidence bug
            // patterns ossify a guess about a problem we don't really
            // understand, which is exactly what staleness would amplify.
            recordBugPattern(
              run.cwd as string,
              summary,
              bb.proposedFix?.filesAffected,
              { runId: body.runId, trigger: "on_error" },
              { confidence: briefResult.confidence },
            ).catch(() => { /* best-effort */ })
          }
        }
      } catch (err) {
        console.warn(`[reasoning] on_error failed:`, (err as Error).message)
      }
    }
  } else {
    consecutiveToolErrors.set(body.runId, 0)
    // ─── Stage 5: record error_pattern on successful recovery ───
    // If the prior tool-result call stashed a failed-command and the
    // agent's NEXT response (whose results we're processing now) ran
    // the SAME tool kind with DIFFERENT args, that's a recovered-from
    // error. Persist it so the next similar error short-circuits.
    const pending = pendingErrorRecovery.get(body.runId)
    if (pending && pending.attemptedTool === pending.failedTool && pending.attemptedArgs && run.cwd) {
      const workingCommand = typeof pending.attemptedArgs.command === "string" ? pending.attemptedArgs.command : ""
      // Only when the success had no error AND the working command
      // actually differs from the failed one (i.e. the agent CHANGED
      // approach, not retried verbatim).
      const successResults = isBatch ? body.toolResults! : [{ id: "single", tool: body.tool, result: body.result }]
      const matchingSuccess = successResults.find((tr) => tr.tool === pending.failedTool && !(tr.result as Record<string, unknown>).error && (tr.result as Record<string, unknown>).success !== false)
      if (workingCommand && matchingSuccess && workingCommand.trim() !== pending.failedCommand.trim()) {
        const recallEnabled = (() => {
          try { return getFlag<boolean>("memory.error_pattern_recall_enabled", run.sysbasePath as string | undefined) }
          catch { return true }
        })()
        if (recallEnabled) {
          recordErrorPattern({
            cwd: run.cwd as string,
            errorClass: pending.errorClass,
            platform: pending.platform,
            failedCommand: pending.failedCommand,
            workingCommand,
            errorSignature: pending.errorText,
            runId: body.runId,
          }).then((entry) => {
            if (entry) console.log(`[error-pattern] recorded recovery: ${pending.failedCommand} → ${workingCommand}`)
          }).catch(() => { /* best-effort */ })
        }
      }
    }
    pendingErrorRecovery.delete(body.runId)
  }

  // ─── Stage 4 of agent-runtime-fixes plan: per-turn directory refresh ───
  // When the cli executor sent a fresh directoryTree (it does this after
  // mutating tool batches), ingest it. The ingest call detects top-level
  // files the working context tracked as present that no longer appear
  // on disk — common when the agent deleted them via `rm` or
  // `delete_file`, or when the directory was reset externally. Inject a
  // one-shot reminder so the next response doesn't reference deleted
  // files. Best-effort; failures degrade silently.
  if (Array.isArray(body.directoryTree) && body.directoryTree.length >= 0) {
    try {
      const { staleFiles } = ingestDirectoryTree(body.runId, body.directoryTree as Array<{ name: string; type: "file" | "directory" }>)
      if (staleFiles.length > 0) {
        console.log(`[directory-refresh] ${staleFiles.length} stale top-level file(s): ${staleFiles.slice(0, 5).join(", ")}`)
        const block = `═══ DIRECTORY STATE CHANGED ═══

The following ${staleFiles.length} top-level file${staleFiles.length === 1 ? "" : "s"} ${staleFiles.length === 1 ? "is" : "are"} NO LONGER ON DISK since the previous turn:
${staleFiles.slice(0, 12).map((p) => `  - ${p}`).join("\n")}${staleFiles.length > 12 ? `\n  … and ${staleFiles.length - 12} more` : ""}

Do NOT reference these files in your next action. Do NOT try to read or edit them — they don't exist. Use the refreshed PROJECT STATE block as your source of truth.

═══ END DIRECTORY STATE CHANGED ═══`
        actionPlanner.injectContext(body.runId, block)
      }
    } catch (err) {
      console.warn(`[directory-refresh] failed:`, (err as Error).message)
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

  // ─── Phase 10: chunked-reasoning loop — per-turn reflect + plan.
  //
  // When the chunked loop is active AND the run has at least one chunk
  // recorded by the initial planner call (in user-message.ts), we run two
  // cheap Gemini Flash calls between every main-model turn:
  //
  //   1. chunk_reflect  — verify the just-executed chunk is coherent
  //   2. chunk_plan     — pick the next 1-5 files
  //
  // Reflector's `shouldStop` short-circuits to a `completed` envelope.
  // `max_chunks_per_run` is a hard cap to prevent runaway loops.
  //
  // Failures (no GEMINI_API_KEY, network blip) degrade gracefully: we just
  // call the main model without the chunk briefs.
  let chunkPlanBrief: ChunkPlanBrief | null = null
  let chunkReflectionBrief: ChunkReflectionBrief | null = null
  try {
    const chunkedLoopOn = getFlag<boolean>("reasoning.chunked_loop_enabled", run.sysbasePath as string | null | undefined)
    const activeChunks = chunkStateCount(body.runId)

    if (chunkedLoopOn && activeChunks > 0) {
      const latestChunk = getLatestChunk(body.runId)!

      // Step 1: reflect on the just-executed chunk.
      const toolSummaries = isBatch
        ? body.toolResults!.map((tr) => ({ tool: tr.tool, ok: !tr.result?.error, hint: typeof tr.result?.error === "string" ? tr.result.error : null }))
        : [{ tool: body.tool, ok: !body.result?.error, hint: typeof body.result?.error === "string" ? body.result.error : null }]

      const reflectResult = await runReasoning({
        trigger: "chunk_reflect",
        userMessage: run.content,
        model: run.model,
        cwd: run.cwd as string | undefined,
        sysbasePath: run.sysbasePath as string | null | undefined,
        runId: body.runId,
        context: {
          originalUserPrompt: run.content,
          chunkPlan: latestChunk.plan,
          executedFiles: latestChunk.executedFiles,
          toolResults: toolSummaries,
        },
      })

      if (reflectResult?.chunkReflectionBrief) {
        chunkReflectionBrief = reflectResult.chunkReflectionBrief
        attachReflection(body.runId, latestChunk.index, chunkReflectionBrief)

        // Stage 2 of free-tier quality enforcement: apply the reflector's
        // ledger updates. The reflector watches each chunk's writes and
        // bumps the high-level subtask statuses; the task-ledger module
        // drops unknown ids defensively. Updates land BEFORE the chunk
        // summary persist so the next turn's system prompt reflects the
        // new state.
        const ledgerUpdates = chunkReflectionBrief.ledgerUpdates ?? []
        if (Array.isArray(ledgerUpdates) && ledgerUpdates.length > 0) {
          applyLedgerUpdates(body.runId, ledgerUpdates)
        }

        // Persist this chunk's outcome to memory so /continue can resume it.
        recordChunkSummary(
          run.cwd as string,
          {
            chunkIndex: latestChunk.index,
            nextAction: latestChunk.plan.nextAction,
            executedFiles: latestChunk.executedFiles,
            reflection: chunkReflectionBrief,
          },
          { runId: body.runId, trigger: "chunk_reflect" },
        ).catch(() => { /* best-effort */ })
      }

      // ─── Phase 11 Stage 1+2+3: heuristic + gate + LLM divergence check.
      // Run every chunk boundary right after the reflector. Heuristic is
      // pure (in-memory); the gate reads files from disk in parallel
      // (<1s budget); the LLM half (Flash, ~300 tok) fires either when
      // heuristics flag OR every 2nd chunk, with a per-run cap. All three
      // signal streams merge into one tracker update. Stage 4 is when this
      // graduates to user-visible auto-pause behaviour.
      try {
        const awarenessOn = getFlag<boolean>("awareness.enabled", run.sysbasePath as string | null | undefined)
        const cooldownLeft = awarenessCooldownChunks.get(body.runId) ?? 0
        if (awarenessOn && cooldownLeft > 0) {
          // Phase 11 Stage 4: post-resolution cooldown. After the user just
          // resolved an off-course modal, mute the awareness loop for a few
          // chunks so a `continue the task` re-prompt doesn't trip the same
          // signals immediately.
          awarenessCooldownChunks.set(body.runId, cooldownLeft - 1)
          console.log(`[awareness] in cooldown (${cooldownLeft - 1} chunk(s) remaining), skipping`)
        } else if (awarenessOn) {
          // Phase 15 Stage 5: prefer the recorded `original_intent` as the
          // divergence anchor when the current run's prompt is a short
          // continuation ("/continue", "fix it", "what's missing?"). The
          // verbatim prompt from a previous run is the canonical record
          // of what the project is trying to be — comparing chunks
          // against "/continue" gives the pipeline nothing to compare,
          // while comparing against the original ask catches drift even
          // on follow-up turns.
          let anchorPrompt = run.content
          try {
            if (run.cwd) {
              const recall = await recallForReasoning({
                cwd: run.cwd as string,
                userMessage: "",
                kind: "original_intent",
                maxEntries: 5,
              })
              const candidates = recall.entries.map((e) => e.content)
              anchorPrompt = pickDivergenceAnchor(run.content, candidates)
            }
          } catch (err) {
            console.warn(`[awareness] original_intent recall failed:`, (err as Error).message)
          }

          const input = buildDetectorInput(body.runId, anchorPrompt)
          let heuristicSignals = detectDivergence(input)
          // Stage 4 of command-first-investigation: allow per-heuristic
          // kill switch for the new `no_investigation_before_write` signal
          // in case it over-fires on a legitimate prompt pattern. Detector
          // stays pure; caller filters.
          const noInvestigationFlagOn = (() => {
            try { return getFlag<boolean>("awareness.no_investigation_heuristic_enabled", run.sysbasePath as string | undefined) }
            catch { return true }
          })()
          if (!noInvestigationFlagOn) {
            heuristicSignals = heuristicSignals.filter((s) => s.category !== "no_investigation_before_write")
          }
          // Stage 5: respect the cross-check flag at chunk boundary too.
          const crossCheckFlagOn = (() => {
            try { return getFlag<boolean>("quality.reasoning_action_cross_check_enabled", run.sysbasePath as string | undefined) }
            catch { return true }
          })()
          if (!crossCheckFlagOn) {
            heuristicSignals = heuristicSignals.filter((s) => s.category !== "reasoning_action_mismatch")
          }
          const gateOutcomes = await runVerificationGate({
            cwd: run.cwd as string,
            filesModified: input.filesModified,
            createdDirs: input.createdDirs,
          })
          const gateSigs = gateSignals(gateOutcomes)

          // LLM half: fire when heuristics flagged anything (ad-hoc) OR
          // we're at least 2 chunks past the last LLM check (cadence).
          const llmSignals: typeof heuristicSignals = []
          const chunkIdx = latestChunk.index
          const lastChecked = lastLlmDivergenceCheckedChunk.get(body.runId) ?? -2
          const heuristicFired = heuristicSignals.length + gateSigs.length > 0
          const cadenceDue = chunkIdx - lastChecked >= 2
          const underCap = lastChecked === -2 || (chunkIdx - lastChecked) <= MAX_LLM_DIVERGENCE_PER_RUN * 2
          if ((heuristicFired || cadenceDue) && underCap) {
            try {
              const firstVerdict = await runReasoning({
                trigger: "divergence_check",
                userMessage: anchorPrompt, // Phase 15 Stage 5: anchor = pickDivergenceAnchor result
                model: run.model,
                cwd: run.cwd as string | undefined,
                sysbasePath: run.sysbasePath as string | null | undefined,
                runId: body.runId,
                context: {
                  originalUserPrompt: anchorPrompt,
                  filesModified: input.filesModified.slice(0, 30),
                  chunkCount: input.chunkHistory.length,
                  lastReflection: chunkReflectionBrief,
                  recentHeuristicSignals: heuristicSignals.slice(0, 4).map((s) => ({ category: s.category, detail: s.detail })),
                },
              })
              lastLlmDivergenceCheckedChunk.set(body.runId, chunkIdx)

              // Phase 16 Stage 4: chained divergence second-look.
              // When the first verdict's score lands in the borderline band
              // (40-60) on a free-tier model, fire a SECOND divergence call
              // with the first verdict carried in its context. The second
              // verdict replaces the first — the deeper look is what we
              // trust. Decisive scores (≤40 off-course, ≥60 on-track)
              // don't need a second-guess; the band is exactly where the
              // confidence is genuinely uncertain.
              let verdict = firstVerdict
              const firstDvb = firstVerdict?.divergenceVerdictBrief
              if (
                firstDvb
                && shouldRunDivergenceSecondLook({
                  model: run.model as string,
                  firstVerdictScore: firstDvb.score,
                  flagEnabled: ((): boolean => {
                    try { return getFlag<boolean>("reasoning.chained.divergence_second_look_enabled", run.sysbasePath as string | null | undefined) }
                    catch { return true }
                  })(),
                })
              ) {
                try {
                  const secondVerdict = await runReasoning({
                    trigger: "divergence_check",
                    userMessage: anchorPrompt,
                    model: run.model,
                    cwd: run.cwd as string | undefined,
                    sysbasePath: run.sysbasePath as string | null | undefined,
                    runId: body.runId,
                    context: {
                      originalUserPrompt: anchorPrompt,
                      filesModified: input.filesModified.slice(0, 30),
                      chunkCount: input.chunkHistory.length,
                      lastReflection: chunkReflectionBrief,
                      recentHeuristicSignals: heuristicSignals.slice(0, 4).map((s) => ({ category: s.category, detail: s.detail })),
                      // Carry the first verdict so the model knows this is a SECOND look.
                      priorVerdict: {
                        onTrack: firstDvb.onTrack,
                        score: firstDvb.score,
                        mismatches: firstDvb.mismatches.slice(0, 6),
                        suggestion: firstDvb.suggestion,
                      },
                      secondLookHint: "The first divergence call returned a borderline score. Re-check carefully — confirm or correct.",
                    },
                  })
                  if (secondVerdict?.divergenceVerdictBrief) {
                    verdict = secondVerdict
                    console.log(`[awareness] divergence second-look: first score=${firstDvb.score} → second score=${secondVerdict.divergenceVerdictBrief.score}`)
                  }
                } catch (err) {
                  console.warn(`[awareness] divergence second-look failed:`, (err as Error).message)
                }
              }

              const dvb = verdict?.divergenceVerdictBrief
              if (verdict && dvb && dvb.onTrack === false && dvb.mismatches.length > 0) {
                llmSignals.push({
                  category: "llm_off_track",
                  detail: `LLM verdict (${verdict.confidence}): ${dvb.mismatches.slice(0, 3).join("; ")}`,
                  severity: dvb.suggestion === "backtrack" ? "major" : "moderate",
                })
                lastDivergenceVerdict.set(body.runId, {
                  mismatches: dvb.mismatches.slice(0, 6),
                  suggestion: dvb.suggestion,
                  score: dvb.score,
                })
                console.log(`[awareness] LLM divergence verdict score=${dvb.score} suggestion=${dvb.suggestion}`)
              }
            } catch (err) {
              console.warn(`[awareness] LLM divergence call failed:`, (err as Error).message)
            }
          }

          const allSignals = [...heuristicSignals, ...gateSigs, ...llmSignals]
          if (allSignals.length > 0) {
            recordConfidenceSignals(body.runId, allSignals)
          }
          const score = getConfidence(body.runId)
          const state = getThresholdState(body.runId, run.sysbasePath as string | null | undefined, run.model as string | undefined)
          if (allSignals.length > 0) {
            console.log(`[awareness] chunk ${chunkIdx}: ${heuristicSignals.length} heuristic + ${gateSigs.length} gate + ${llmSignals.length} llm signal(s), confidence=${score} state=${state}`)
          }

          // ─── Phase 11 Stage 4: hand the wheel back when blocked ───
          // Confidence dropped past awareness.threshold_blocked. Short-circuit
          // with a `waiting_for_user` carrying the evidence — the cli renders
          // the off-course modal and the user picks continue/backtrack/redirect.
          if (state === "blocked") {
            const fullState = getConfidenceState(body.runId)
            const verdict = lastDivergenceVerdict.get(body.runId) ?? null
            // Roll back the chunk that JUST crossed the threshold — its
            // snapshot was taken at the start of this chunk.
            const lastGoodChunkIndex = chunkIdx
            const message = `Confidence dropped to ${Math.round(score)}/100 — I think the run drifted from your ask. What should I do?`
            console.log(`[awareness] chunk ${chunkIdx}: BLOCKED (confidence=${score}). Surfacing off-course modal to user.`)

            const synthesised: NormalizedResponse = {
              kind: "waiting_for_user",
              content: message,
              usage: { inputTokens: 0, outputTokens: 0 },
            }
            const resp = mapNormalizedResponseToClient(body.runId, synthesised) as unknown as Record<string, unknown>
            // Custom payload the cli inspects to route to the off-course modal
            // instead of the generic askUser path.
            resp.awarenessChoice = true
            resp.awarenessEvidence = {
              confidence: score,
              signals: (fullState?.signals ?? []).slice(-6).map((s) => ({
                category: s.category,
                detail: s.detail,
                severity: s.severity ?? null,
              })),
              lastLlmVerdict: verdict,
              lastGoodChunkIndex,
            }
            return resp as unknown as ClientResponse
          }
        }
      } catch (err) {
        // Awareness path is best-effort; never let it break the chunk loop.
        console.warn(`[awareness] detector/gate failed:`, (err as Error).message)
      }

      // Reflector says we're done — short-circuit to completed.
      if (chunkReflectionBrief?.shouldStop) {
        console.log(`[chunked-loop] chunk ${latestChunk.index}: reflector says shouldStop, completing`)
        clearPipeline(body.runId)
        clearChunkState(body.runId)
        const synthesised: NormalizedResponse = {
          kind: "completed",
          content: chunkReflectionBrief.nextFocus || "Chunked task complete — reflector flagged we're done.",
          usage: { inputTokens: 0, outputTokens: 0 },
        }
        const resp = mapNormalizedResponseToClient(body.runId, synthesised)
        ;(resp as unknown as Record<string, unknown>).chunkReflectionBrief = chunkReflectionBrief
        return resp
      }

      // Hard cap: prevent runaway loops. Phase 16 Stage 5: free-tier
      // models get a tightened cap (default 0.7× = 12 → 8 chunks) so a
      // free model can't overshoot its affordable budget. Paid models
      // keep the configured `reasoning.max_chunks_per_run` value.
      const baseMaxChunks = getFlag<number>("reasoning.max_chunks_per_run", run.sysbasePath as string | null | undefined)
      const maxChunks = resolveMaxChunksPerRun(run.model as string, baseMaxChunks)
      if (activeChunks >= maxChunks) {
        console.warn(`[chunked-loop] hit max_chunks_per_run=${maxChunks} (base=${baseMaxChunks}, model=${run.model}), stopping`)
        clearPipeline(body.runId)
        clearChunkState(body.runId)
        const synthesised: NormalizedResponse = {
          kind: "completed",
          content: `Stopped after ${activeChunks} chunks (max_chunks_per_run cap). The work so far is on disk; ask me to /continue if you want more.`,
          usage: { inputTokens: 0, outputTokens: 0 },
        }
        return mapNormalizedResponseToClient(body.runId, synthesised)
      }

      // Step 2: plan the next chunk.
      const planResult = await runReasoning({
        trigger: "chunk_plan",
        userMessage: run.content,
        model: run.model,
        cwd: run.cwd as string | undefined,
        sysbasePath: run.sysbasePath as string | null | undefined,
        runId: body.runId,
        context: {
          originalUserPrompt: run.content,
          chunkHistory: getChunkHistory(body.runId).map((c) => ({
            index: c.index,
            plan: c.plan,
            executedFiles: c.executedFiles,
            reflection: c.reflection,
          })),
          lastReflection: chunkReflectionBrief,
        },
      })

      if (planResult?.chunkPlanBrief) {
        chunkPlanBrief = planResult.chunkPlanBrief
        // Phase 16 Stage 5: tighten the planner's file list to the
        // free-tier cap. Paid-tier slice is a no-op (cap = schema max 5).
        const maxFiles = resolveMaxFilesPerChunk(run.model as string)
        if (chunkPlanBrief.files.length > maxFiles) {
          chunkPlanBrief.files = chunkPlanBrief.files.slice(0, maxFiles)
        }
        recordChunkStart(body.runId, chunkPlanBrief, [...chunkPlanBrief.files])
        console.log(`[chunked-loop] chunk ${activeChunks} planned: ${chunkPlanBrief.nextAction} (${chunkPlanBrief.files.length} files, cap=${maxFiles})`)
      }
    }
  } catch (err) {
    console.warn(`[chunked-loop] reflect/plan failed:`, (err as Error).message)
  }

  // Phase 10: stamp the just-planned chunk's brief onto the provider payload
  // so the prompt builder can render the CHUNK PLAN section the model sees.
  if (chunkPlanBrief) providerPayload.chunkPlanBrief = chunkPlanBrief

  let normalized = await callModelAdapter(providerPayload as never)

  // ─── Stage 4 of forced-error-reasoning plan: ack-rejection loop ───
  // When the prior turn fired an error-reasoning brief, validate the
  // model's response addressed the error. If not, inject a stronger
  // reject prompt + re-call the adapter. Capped at 3 rejections per
  // run so a stuck model can't hold the handler forever.
  if (errorReasoningChainBrief && incomingErrors.length > 0) {
    const ackFlagOn = (() => {
      try { return getFlag<boolean>("quality.error_acknowledgement_rejection_enabled", run.sysbasePath as string | undefined) }
      catch { return true }
    })()
    if (ackFlagOn) {
      const lastError = incomingErrors[incomingErrors.length - 1]
      const failedToolName = lastError.tool
      const failedResult = lastError.result as Record<string, unknown>
      const failedArgs = (failedResult.args as Record<string, unknown> | undefined) ?? undefined
      const errCtx = {
        errorText: typeof failedResult.error === "string" ? failedResult.error : typeof failedResult.stderr === "string" ? failedResult.stderr : "",
        rootCause: errorReasoningChainBrief.rootCause,
        failedTool: failedToolName,
        failedPrimaryArg: primaryArg(failedToolName, failedArgs),
      }
      let rejections = errorAcknowledgementRejections.get(body.runId) ?? 0
      while (rejections < MAX_ERROR_ACK_REJECTIONS) {
        const check = validateErrorAcknowledgement({
          responseKind: normalized.kind,
          reasoningChain: Array.isArray(normalized.reasoningChain) ? normalized.reasoningChain : [],
          content: typeof normalized.content === "string" ? normalized.content : null,
          responseTool: typeof normalized.tool === "string" ? normalized.tool : null,
          responseArgs: (normalized.args as Record<string, unknown> | undefined) ?? null,
          context: errCtx,
        })
        if (check.ok) break

        rejections += 1
        errorAcknowledgementRejections.set(body.runId, rejections)
        console.log(`[error-ack] rejection ${rejections}/${MAX_ERROR_ACK_REJECTIONS}: ${check.reason}`)
        // Inject the reject prompt as additional context so the
        // next call sees it. Use the actionPlanner's pendingContext
        // (consumed exactly once) — same channel the verify /
        // self-review blocks land through.
        actionPlanner.injectContext(body.runId, buildErrorAcknowledgementRejectPrompt(check, errCtx, rejections, MAX_ERROR_ACK_REJECTIONS))
        normalized = await callModelAdapter(providerPayload as never)
      }
      // After the loop: either validator passed, OR we hit the cap.
      // In both cases, clear the rejection counter so the next run
      // starts fresh. Phase 11 awareness's `same_action_repeated_in_session`
      // catches sustained drift past this point.
      if (rejections >= MAX_ERROR_ACK_REJECTIONS) {
        console.warn(`[error-ack] hit rejection cap (${MAX_ERROR_ACK_REJECTIONS}); proceeding without ack — Phase 11 awareness will catch sustained drift`)
      }
    }
  }

  // ─── Stage 5: capture the agent's attempted recovery ───
  // If this call processed an error AND the model just emitted a
  // tool-call response, that response IS the agent's recovery attempt.
  // Stash its args alongside the pending failed-command so the NEXT
  // handler call (which sees whether the recovery worked) can record
  // a complete `error_pattern` entry.
  if (incomingErrors.length > 0 && normalized.kind === "needs_tool") {
    const pending = pendingErrorRecovery.get(body.runId)
    if (pending) {
      const attemptedTool = typeof normalized.tool === "string" ? normalized.tool : undefined
      const attemptedArgs = (normalized.args as Record<string, unknown> | undefined) ?? undefined
      if (attemptedTool) {
        pendingErrorRecovery.set(body.runId, { ...pending, attemptedTool, attemptedArgs })
      }
    }
  }

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

  // ─── Stage 3 of agent-code-correctness plan: pre-completion tsc gate ───
  // When the run authored .ts/.tsx files AND tsconfig.json exists,
  // run `tsc --noEmit` BEFORE accepting completion. If typecheck has
  // errors, override the response to needs_tool + inject the
  // diagnostics so the agent fixes them before re-declaring done.
  // Gracefully skips when tsc isn't installed / no tsconfig. Closes
  // the user-reported repro where the agent shipped a POS backend
  // with cascading TS errors that only surfaced at `npm run dev`.
  if (normalized.kind === "completed" && !isFatal && run.cwd) {
    const tscGateOn = (() => {
      try { return getFlag<boolean>("quality.precompletion_tsc_gate_enabled", run.sysbasePath as string | undefined) }
      catch { return true }
    })()
    if (tscGateOn) {
      const tscTimeout = (() => {
        try { return getFlag<number>("quality.precompletion_tsc_timeout_ms", run.sysbasePath as string | undefined) }
        catch { return 30_000 }
      })()
      const filesAuthored = getRunActions(body.runId).filesModified
      try {
        const tscResult = await runTscGate({
          cwd: run.cwd as string,
          filesWritten: filesAuthored,
          timeoutMs: tscTimeout,
        })
        if (tscResult.ran && !tscResult.ok) {
          console.log(`[tsc-gate] BLOCKED completion: ${tscResult.errorCount} typecheck error(s) — injecting diagnostics + overriding to needs_tool`)
          actionPlanner.injectContext(body.runId, buildTscFailedInject(tscResult))
          normalized = {
            kind: "needs_tool",
            tool: "list_directory",
            args: { path: "." },
            content: `Completion blocked: ${tscResult.errorCount} typecheck error${tscResult.errorCount === 1 ? "" : "s"} detected. Read the inject block and fix before declaring done again.`,
            reasoning: "tsc --noEmit reported errors — overriding completion to force fix.",
            reasoningChain: normalized.reasoningChain,
            usage: normalized.usage,
          }
        } else if (tscResult.skippedReason) {
          console.log(`[tsc-gate] skipped: ${tscResult.skippedReason}`)
        }
      } catch (err) {
        console.warn(`[tsc-gate] gate threw — degrading to accept completion: ${(err as Error).message}`)
      }
    }
  }

  // ─── Stage 4 of agent-code-correctness plan: prompt-implied artifact gate ───
  // After tsc passes (or skips), check whether the prompt implied
  // artifacts that don't exist on disk yet. Example: prompt mentions
  // PostgreSQL but no schema.sql / migrations file exists. Blocks
  // completion + injects directive listing each missing artifact
  // with concrete file examples. Conservative keyword matching keeps
  // false-positives low; gracefully no-ops when prompt is unambiguous.
  if (normalized.kind === "completed" && !isFatal && run.cwd) {
    const artifactGateOn = (() => {
      try { return getFlag<boolean>("quality.completion_artifact_check_enabled", run.sysbasePath as string | undefined) }
      catch { return true }
    })()
    if (artifactGateOn) {
      try {
        const result = await checkImpliedArtifacts(run.content as string, run.cwd as string)
        if (!result.ok && result.missing.length > 0) {
          const summary = result.missing.map((m) => m.kind).join(", ")
          console.log(`[artifact-gate] BLOCKED completion: missing implied artifact(s): ${summary} — injecting directive + overriding to needs_tool`)
          actionPlanner.injectContext(body.runId, buildArtifactMissingInject(result.missing))
          normalized = {
            kind: "needs_tool",
            tool: "list_directory",
            args: { path: "." },
            content: `Completion blocked: ${result.missing.length} prompt-implied artifact${result.missing.length === 1 ? "" : "s"} missing (${summary}). Read the inject block and create the file(s) before declaring done again.`,
            reasoning: "Prompt-implied artifact missing — overriding completion to force creation.",
            reasoningChain: normalized.reasoningChain,
            usage: normalized.usage,
          }
        }
      } catch (err) {
        console.warn(`[artifact-gate] check threw — degrading to accept completion: ${(err as Error).message}`)
      }
    }
  }

  // ─── Phase 5: on-completion reasoning ───
  // For non-trivial runs (≥ 5 actions OR ≥ 3 files modified), refine the
  // user-facing summary via the summary pipeline before returning it.
  let onCompletionBrief: unknown = null
  if (normalized.kind === "completed" && !isFatal) {
    const runLog = getRunActions(body.runId)
    const isNonTrivial = runLog.actions.length >= 5 || runLog.filesModified.length >= 3
    if (isNonTrivial) {
      try {
        const briefResult = await runReasoning({
          trigger: "on_completion",
          userMessage: `Refine this completion summary for the user. Original task: "${run.content}".`,
          model: run.model,
          cwd: run.cwd as string | undefined,
          sysbasePath: run.sysbasePath as string | undefined,
          runId: body.runId,
          context: {
            originalTask: run.content,
            filesModified: runLog.filesModified.slice(0, 30),
            actionCount: runLog.actions.length,
            draftMessage: normalized.content || "",
          },
        })
        onCompletionBrief = briefResult
        if (briefResult && briefResult.pipeline === "summary" && briefResult.summaryBrief) {
          // Phase 8: persist the summary brief as memory so future runs see it.
          // Phase 15 Stage 2: thread `confidence` through so the recorder's
          // internal LOW-skip can drop a low-confidence summary without the
          // call site having to remember the rule.
          recordImplementSummary(
            run.cwd as string,
            { implementBrief: { intent: run.content, recommendedStack: undefined, consistencyNotes: briefResult.summaryBrief.constraints }, confidence: briefResult.confidence },
            { runId: body.runId, trigger: "on_completion" },
          ).catch(() => { /* best-effort */ })
          // Replace the draft message with a rendered summary.
          const sb = briefResult.summaryBrief
          const lines: string[] = []
          for (const c of sb.clusters) {
            lines.push(`## ${c.heading}`)
            for (const p of c.points) lines.push(`- ${p}`)
            lines.push("")
          }
          if (sb.constraints.length > 0) {
            lines.push("## Notes")
            for (const c of sb.constraints) lines.push(`- ${c}`)
            lines.push("")
          }
          if (sb.whatMatters.length > 0) {
            lines.push("## What matters")
            for (const w of sb.whatMatters) lines.push(`- ${w}`)
          }
          normalized.content = lines.join("\n").trim() || normalized.content
        }
      } catch (err) {
        console.warn(`[reasoning] on_completion failed:`, (err as Error).message)
      }
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
    consecutiveToolErrors.delete(body.runId)
    onErrorReasoningCount.delete(body.runId)
  }

  // ─── Task Pipeline: track progress only if the AI created a plan on turn one.
  // No fallback pipeline — see #12. If hasPipeline is false here it means the
  // initial turn didn't produce a taskPlan, and we leave it that way.
  if (normalized.kind === "needs_tool") {
    if (normalized.taskPlan && normalized.taskPlan.steps.length > 0 && !hasPipeline(body.runId)) {
      const pipeline = createPipelineFromAiPlan(body.runId, run.content, normalized.taskPlan)
      normalized.task = pipelineToTaskMeta(pipeline)
    }
    if (hasPipeline(body.runId)) {
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

  // Phase 15 Stage 4: apply the model's memoryFeedback against the
  // on-disk store (cross-validation guards in feedback.ts). Same gating
  // as user-message.ts. Best-effort.
  if (
    run.cwd
    && normalized.memoryFeedback
    && getFlag<boolean>("memory.active_confirmation_enabled", run.sysbasePath as string | null | undefined)
  ) {
    applyMemoryFeedback(run.cwd as string, normalized.memoryFeedback, normalized.content || "")
      .then((audit) => {
        if (audit.confirmedHonoured.length > 0 || audit.contradictedHonoured.length > 0) {
          console.log(`[memory] feedback applied: confirmed=${audit.confirmedHonoured.length} contradicted=${audit.contradictedHonoured.length} (rejected: c=${audit.confirmedRejected.length} d=${audit.contradictedRejected.length})`)
        }
      })
      .catch(() => { /* best-effort */ })
  }

  // Stage 5 of free-tier-quality-enforcement: cache the per-turn
  // reasoningChain so the NEXT tool-result can run the reasoner-vs-action
  // cross-check against whatever action the agent emits.
  if (Array.isArray(normalized.reasoningChain)) {
    setLastReasoning(body.runId, normalized.reasoningChain)
  }

  const response = mapNormalizedResponseToClient(body.runId, normalized)
  if (onErrorBrief) response.reasoningBrief = onErrorBrief
  if (onCompletionBrief) response.reasoningBrief = onCompletionBrief
  // Stage E of model-lock-and-portable-reasoning: surface the run's
  // reasoner backend so the CLI can record it in `RunSummary`. Constant
  // for the run; absent until at least one runReasoning call has
  // resolved a backend.
  const reasonerBackend = getReasonerBackendForRun(body.runId)
  if (reasonerBackend) response.reasonerBackend = reasonerBackend
  // Phase 19: surfacing runIntent on every response lets the CLI gate
  // the task box defensively even if the initial user-message response
  // was lost. Reads the per-run cache populated by user-message.ts's
  // `classifyIntentSmart` (Stage 4 of LLM iterative intent
  // classification plan); falls back to regex on cache miss.
  response.runIntent = getCachedIntentOrRegex(body.runId, run.content)
  // Stage 3 of forced-error-reasoning plan: surface the chain's
  // paragraphs (for <ReasoningPeek> plain-prose render via PR #83) +
  // source (for usage.jsonl telemetry). Both fields stay absent on
  // turns where no error fired.
  if (errorReasoningChainBrief) {
    response.errorReasoningParagraphs = errorReasoningChainBrief.paragraphs
  }
  if (errorReasoningSource) {
    response.errorReasoningSource = errorReasoningSource
  }
  // Stage 6: surface the running rejection count so the CLI can
  // capture max-observed in RunSummary.errorAcknowledgementRejections.
  // Only set when a chain brief was produced this turn — otherwise the
  // ack loop didn't run and the count is meaningless for this response.
  if (errorReasoningChainBrief && incomingErrors.length > 0) {
    response.errorAckRejectionCount = errorAcknowledgementRejections.get(body.runId) ?? 0
  }
  // Phase 10: surface the chunk briefs so the CLI can render the boundary.
  if (chunkPlanBrief) (response as unknown as Record<string, unknown>).chunkPlanBrief = chunkPlanBrief
  if (chunkReflectionBrief) (response as unknown as Record<string, unknown>).chunkReflectionBrief = chunkReflectionBrief

  // Phase 11 Stage 5: surface a per-response awareness snapshot so the CLI
  // can render the confidence badge inline with chunk progress. Only attach
  // when awareness is enabled — otherwise the field is omitted and the cli
  // renders the legacy chunk box. Best-effort: if either lookup throws, we
  // skip the badge rather than fail the response.
  try {
    const awarenessOn = getFlag<boolean>("awareness.enabled", run.sysbasePath as string | null | undefined)
    if (awarenessOn) {
      const score = getConfidence(body.runId)
      const state = getThresholdState(body.runId, run.sysbasePath as string | null | undefined, run.model as string | undefined)
      const fullState = getConfidenceState(body.runId)
      const lastSignal = (fullState?.signals.length ?? 0) > 0
        ? fullState!.signals[fullState!.signals.length - 1].detail
        : null
      ;(response as unknown as Record<string, unknown>).awarenessSnapshot = {
        state,
        confidence: score,
        lastSignal,
      }
    }
  } catch {
    // Non-fatal — the response goes back without the snapshot.
  }

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
    // Phase 10: tear down chunk-state on every terminal outcome (paired with
    // the existing clearPipeline call elsewhere).
    clearChunkState(body.runId)
    // Phase 11: tear down per-run confidence state on the same terminal path.
    clearConfidence(body.runId)
    // Stage 2 of free-tier quality enforcement: tear down per-run task
    // ledger on the same terminal path so a stale ledger doesn't bleed
    // into the next run from the same chat.
    clearLedger(body.runId)
    // Stage 3 of free-tier quality enforcement: tear down per-run review
    // cadence state too. Without this, the lastReviewAtChunk from the
    // prior run would persist and the first review of the next run
    // would fire at the wrong cadence.
    clearReviewState(body.runId)
    // Stage 5 of free-tier quality enforcement: drop the cached per-turn
    // reasoningChain so the next run starts clean.
    clearLastReasoning(body.runId)
    // Stage E of model-lock-and-portable-reasoning: drop the per-run
    // reasoner backend telemetry entry.
    clearReasonerBackendForRun(body.runId)
    // Stage 4 of llm-iterative-intent-classification: drop the per-run
    // intent cache so the next run on the same handler reclassifies.
    clearIntentForRun(body.runId)
    // Stage 4 of forced-error-reasoning plan: drop the per-run
    // rejection counter so a subsequent run starts fresh.
    errorAcknowledgementRejections.delete(body.runId)
    // Stage 5: drop any in-flight error-recovery state so a subsequent
    // run doesn't think the prior run's failed command was its own.
    pendingErrorRecovery.delete(body.runId)
    // Stage 5 of command-first-investigation: drop the per-run latch
    // so a subsequent run starts with a fresh reminder budget.
    investigationBudgetReminderFired.delete(body.runId)
    lastLlmDivergenceCheckedChunk.delete(body.runId)
    awarenessCooldownChunks.delete(body.runId)
    lastDivergenceVerdict.delete(body.runId)
  }

  return response
}

// ─── Error enrichment: add recovery hints to tool errors before they reach the AI ───

function enrichSingleError(tool: string, result: Record<string, unknown>): Record<string, unknown> {
  const error = (result.error as string) || ""
  if (!error) return result

  // Trust _errorCategory if the CLI's validation/permission layer already set it.
  const classified = classifyToolErrorFromResult(tool, result)
  if (classified.category !== "unknown") {
    return {
      ...result,
      error: result._errorCategory ? error : `${error}\n\n${classified.hint}`,
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

// ─── Scaffold-command pattern detection ───
const SCAFFOLD_COMMAND_PATTERNS: RegExp[] = [
  /\bnpm\s+create\s+/i,
  /\bnpx\s+(?:--yes\s+)?create-/i,
  /\bnpx\s+(?:--yes\s+)?(?:@nestjs\/cli|@angular\/cli|nuxi|@quick-start\/electron)\b/i,
  /\bdjango-admin\s+startproject\b/i,
  /\bcomposer\s+create-project\b/i,
  /\brails\s+new\b/i,
  /\bbun\s+init\b/i,
]

function looksLikeScaffoldCommand(cmd: string): boolean {
  if (!cmd) return false
  return SCAFFOLD_COMMAND_PATTERNS.some((re) => re.test(cmd))
}

/** Extract the trailing project-name argument from a scaffolder command. */
function extractScaffoldedDir(cmd: string): string | null {
  // Skip the command tokens; find the first non-flag token after a known scaffolder verb.
  const tokens = cmd.split(/\s+/).filter(Boolean)
  let pastVerb = false
  for (const t of tokens) {
    if (!pastVerb) {
      if (/^(create|new|init|startproject|create-project)$/i.test(t) || /^create-/i.test(t)) {
        pastVerb = true
      }
      continue
    }
    if (t.startsWith("-")) continue       // flag
    if (t === "--") continue
    if (/^[a-zA-Z][a-zA-Z0-9._-]+$/.test(t)) return t
  }
  return null
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

/**
 * Stage 5 of command-first-investigation plan: per-run latch so the
 * `[BUDGET]` reminder fires AT MOST ONCE. Once injected, the divergence
 * detector's existing `scope_creep` signal keeps the pressure on if
 * the agent continues to over-investigate. Cleared on terminal exit.
 */
const investigationBudgetReminderFired = new Set<string>()

function maybeInjectInvestigationBudgetReminder(
  runId: string,
  run: Awaited<ReturnType<typeof getRun>>,
): void {
  if (investigationBudgetReminderFired.has(runId)) return

  // Flag-gated kill switch.
  const flagOn = (() => {
    try { return getFlag<boolean>("quality.investigation_budget_reminder_enabled", run.sysbasePath as string | null | undefined) }
    catch { return true }
  })()
  if (!flagOn) return

  const runLog = getRunActions(runId)

  // Count safe-read-only run_commands and detect whether the agent
  // has already written anything. The investigation phase is "before
  // first write" — after the agent transitions to action, the budget
  // reminder is moot.
  let investigationCount = 0
  let hasWritten = false
  for (const a of runLog.actions) {
    if (!a || typeof a.tool !== "string") continue
    if (a.tool === "write_file" || a.tool === "edit_file" || a.tool === "batch_write" || a.tool === "create_directory") {
      hasWritten = true
      break
    }
    if (a.tool === "run_command" && typeof a.command === "string" && isSafeReadOnlyCommand(a.command)) {
      investigationCount += 1
    }
  }
  if (hasWritten) return

  const complexity = analyzeTaskComplexity(run.content).complexity
  // Coarse intent classification — same regex hint the preflight uses.
  // Maps to the policy helper's `intent` parameter; for the budget,
  // only "bug" vs other matters.
  const intentHint = getCachedIntentOrRegex(runId, run.content)
  const budget = getInvestigationBudget({
    model: run.model as string | null | undefined,
    intent: intentHint,
    complexity,
  })

  if (investigationCount <= budget) return

  // Over-budget AND no writes yet → inject the reminder. Single-shot.
  const note = `[BUDGET] You've run ${investigationCount} read-only investigation commands in this run without writing anything yet — that's past the ${budget}-command budget for this task complexity. Switch from investigation to action: open the file(s) you've identified and start implementing. If you genuinely need more investigation, surface the specific question you're trying to answer in \`reasoningChain\` first so the next command is purposeful.`
  actionPlanner.injectContext(runId, note)
  investigationBudgetReminderFired.add(runId)
  console.log(`[budget] investigation reminder fired for run ${runId} at ${investigationCount}/${budget} (intent=${intentHint}, complexity=${complexity})`)
}

/**
 * Phase 11: assemble the divergence detector's input from data already
 * tracked by the run. Pure function over the existing in-memory stores —
 * no I/O. `originalPrompt` is the run.content the user typed.
 *
 * `plannedChunkCount` is intentionally null at Stage 1; Stage 3 will source
 * it from the preflight `implementBrief.buildPlan` once the LLM half lands.
 */
function buildDetectorInput(runId: string, originalPrompt: string): DetectorInput {
  const runLog = getRunActions(runId)
  const chunkHistory = getChunkHistory(runId)

  // Tool-error counts grouped by tool name (good-enough proxy for "category"
  // in Stage 1; the classifier-aware version lands with the LLM half).
  const toolErrorCounts = new Map<string, number>()
  for (const e of runLog.errors) {
    toolErrorCounts.set(e.tool, (toolErrorCounts.get(e.tool) ?? 0) + 1)
  }

  // Directories created via the create_directory tool.
  const createdDirs: string[] = []
  for (const a of runLog.actions) {
    if (a.tool === "create_directory" && typeof a.path === "string") createdDirs.push(a.path)
  }

  // Stage 4 of command-first-investigation: derive investigation count +
  // first write/edit index from the existing actions log. No separate
  // tracker needed — runLog.actions already records every tool call with
  // its primary args (tool name + command + path).
  let investigationCommandCount = 0
  let firstWriteOrEditIndex = -1
  for (let i = 0; i < runLog.actions.length; i++) {
    const a = runLog.actions[i]
    if (a.tool === "run_command" && typeof a.command === "string" && isSafeReadOnlyCommand(a.command)) {
      investigationCommandCount += 1
    }
    if (firstWriteOrEditIndex < 0 && (a.tool === "write_file" || a.tool === "edit_file" || a.tool === "batch_write")) {
      firstWriteOrEditIndex = i
    }
  }

  // Stage 4: complexity gates the no_investigation_before_write heuristic
  // (trivial tasks legitimately skip investigation). analyzeTaskComplexity
  // is a cheap pure helper.
  const complexity = analyzeTaskComplexity(originalPrompt).complexity

  // Stage 4 of free-tier-quality-enforcement: rolling window of the
  // last 6 tool calls feeds the `same_action_repeated_in_session`
  // heuristic. Truncate paths and commands to keep the comparison key
  // stable across stored vs. raw forms (the action log already trims
  // commands to 120 chars, so this is mostly defensive).
  const recentActions = runLog.actions.slice(-6).map((a) => ({
    tool: typeof a.tool === "string" ? a.tool : "",
    path: typeof a.path === "string" ? a.path : undefined,
    command: typeof a.command === "string" ? a.command : undefined,
  }))

  // Stage 5 of free-tier-quality-enforcement: pair the model's last
  // reasoningChain paragraph with the most-recent action so the
  // reasoner-vs-action checker can flag "said-X-did-Y" mismatches.
  // Both fields must be present for the heuristic to fire; missing
  // either is a no-op.
  const cachedChain = getLastReasoning(runId)
  const lastReasoning = cachedChain ? pickLastReasoning(cachedChain) : null
  const latestRaw = runLog.actions[runLog.actions.length - 1]
  let latestAction: { tool: string; path?: string | null; command?: string | null; commandIsSafeReadOnly?: boolean } | null = null
  if (latestRaw && typeof latestRaw.tool === "string") {
    const cmd = typeof latestRaw.command === "string" ? latestRaw.command : null
    latestAction = {
      tool: latestRaw.tool,
      path: typeof latestRaw.path === "string" ? latestRaw.path : null,
      command: cmd,
      commandIsSafeReadOnly: cmd ? isSafeReadOnlyCommand(cmd) : undefined,
    }
  }

  return {
    originalPrompt,
    chunkHistory,
    filesModified: runLog.filesModified.slice(),
    toolErrorCounts,
    createdDirs,
    completionMessage: null,
    plannedChunkCount: null,
    investigationCommandCount,
    firstWriteOrEditIndex,
    complexity,
    recentActions,
    lastReasoning,
    latestAction,
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
