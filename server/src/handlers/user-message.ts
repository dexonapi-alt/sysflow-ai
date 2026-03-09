import crypto from "node:crypto"
import { createTask } from "../services/task.js"
import { loadProjectContext } from "../services/context.js"
import { saveRun } from "../store/runs.js"
import { persistModelUsage } from "../store/usage.js"
import { buildSessionSummary, getLastSession, saveOrphanedSessions, buildContinueContext } from "../store/sessions.js"
import { buildContextForPrompt } from "../store/context.js"
import { callModelAdapter } from "../providers/adapter.js"
import { mapNormalizedResponseToClient } from "../providers/normalize.js"
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
    context.sessionHistory = sessionSummary
  }

  const projectContext = await buildContextForPrompt(body.projectId, body.content)
  if (projectContext) {
    context.projectKnowledge = projectContext
  }

  if (body.command === "/continue") {
    const continueCtx = await buildContinueContext(body.projectId, body.chatId)
    if (continueCtx) {
      context.continueContext = continueCtx
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

  return mapNormalizedResponseToClient(runId, normalized)
}
