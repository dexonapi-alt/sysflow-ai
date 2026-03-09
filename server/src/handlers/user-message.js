import crypto from "node:crypto"
import { createTask } from "../services/task.js"
import { loadProjectContext } from "../services/context.js"
import { saveRun } from "../store/runs.js"
import { persistModelUsage } from "../store/usage.js"
import { buildSessionSummary, getLastSession, saveOrphanedSessions, buildContinueContext } from "../store/sessions.js"
import { buildContextForPrompt } from "../store/context.js"
import { callModelAdapter } from "../providers/adapter.js"
import { mapNormalizedResponseToClient } from "../providers/normalize.js"

export async function handleUserMessage(body) {
  const runId = crypto.randomUUID()
  const taskId = crypto.randomUUID()

  // Flush any orphaned runs (interrupted mid-execution) into session history
  // so the AI remembers what happened even if the previous run didn't complete
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
  })

  // Load session memory — scoped to chat if available, else project-wide
  const sessionSummary = await buildSessionSummary(body.projectId, body.chatId)
  if (sessionSummary) {
    context.sessionHistory = sessionSummary
  }

  // Load project context/patterns/memories from DB (smart keyword filtering)
  const projectContext = await buildContextForPrompt(body.projectId, body.content)
  if (projectContext) {
    context.projectKnowledge = projectContext
  }

  // If this is a "continue" command, load detailed continuation context
  if (body.command === "/continue") {
    const continueCtx = await buildContinueContext(body.projectId, body.chatId)
    if (continueCtx) {
      context.continueContext = continueCtx
    }
    // Also keep the last session for backward compat
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
    task,
    context,
    userMessage: body.content,
    command: body.command,
    directoryTree: body.directoryTree || [],
    projectId: body.projectId,
    userId: body.userId || null,
    chatId: body.chatId || null
  })

  await persistModelUsage({
    runId,
    projectId: body.projectId,
    model: body.model,
    usage: normalized.usage,
    userId: body.userId || null,
    isNewPrompt: true
  })

  return mapNormalizedResponseToClient(runId, normalized)
}
