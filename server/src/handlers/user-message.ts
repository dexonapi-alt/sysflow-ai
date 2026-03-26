import crypto from "node:crypto"
import { createTask } from "../services/task.js"
import { loadProjectContext } from "../services/context.js"
import { saveRun } from "../store/runs.js"
import { persistModelUsage } from "../store/usage.js"
import { buildSessionSummary, getLastSession, saveOrphanedSessions, buildContinueContext } from "../store/sessions.js"
import { buildContextForPrompt } from "../store/context.js"
import { callModelAdapter } from "../providers/adapter.js"
import { mapNormalizedResponseToClient } from "../providers/normalize.js"
import { analyzeTaskComplexity } from "../services/completion-guard.js"
import type { ClientResponse } from "../types.js"

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

  if (body.command === "/continue") {
    const continueCtx = await buildContinueContext(body.projectId, body.chatId)
    if (continueCtx) {
      // Also check for stale continue context
      const currentFiles = (body.directoryTree || []).map((e) => e.name)
      if (currentFiles.length <= 2 && continueCtx.includes("Files already created:")) {
        context.continueContext = `⚠️ FRESH START: Previous files were deleted. Start from scratch. Current directory: ${currentFiles.join(", ") || "(empty)"}`
      } else {
        context.continueContext = continueCtx
      }
    }
    const lastSession = await getLastSession(body.projectId, body.chatId)
    if (lastSession) {
      context.continueFrom = lastSession
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

  const normalized = await callModelAdapter({
    model: body.model,
    runId,
    task: task as never,
    context: context as never,
    userMessage: body.content,
    command: body.command,
    directoryTree: (body.directoryTree || []) as never,
    projectId: body.projectId,
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

  // Layer 3: Guard against AI completing on the FIRST call (before any tools run)
  // For complex tasks, the AI should NEVER say "completed" without running any tools
  if (normalized.kind === "completed") {
    const analysis = analyzeTaskComplexity(body.content)
    if (analysis.complexity !== "simple") {
      console.log(`[user-message] AI tried to complete ${analysis.complexity} task on first call — overriding to needs_tool`)
      normalized.kind = "needs_tool"
      normalized.tool = "list_directory"
      normalized.args = { path: "." }
      normalized.content = "Starting implementation..."
      normalized.reasoning = "I need to implement the full task, not just respond with a summary."
    }
  }

  return mapNormalizedResponseToClient(runId, normalized)
}
