const runs = new Map()

export async function saveRun(data) {
  runs.set(data.runId, {
    id: data.runId,
    taskId: data.taskId,
    projectId: data.projectId,
    model: data.model,
    content: data.content,
    command: data.command,
    cwd: data.cwd,
    sysbasePath: data.sysbasePath,
    userId: data.userId || null,
    chatId: data.chatId || null,
    status: data.status,
    createdAt: new Date().toISOString()
  })
}

export async function getRun(runId) {
  const run = runs.get(runId)
  if (!run) {
    throw new Error(`Run not found: ${runId}`)
  }
  return run
}

export async function finalizeRun(runId, response) {
  const run = runs.get(runId)
  if (run) {
    run.status = "completed"
    run.completedAt = new Date().toISOString()
    run.response = response
  }
}
