import { saveTask } from "../store/tasks.js"

interface CreateTaskParams {
  taskId: string
  runId: string
  prompt: string
  command?: string
  model: string
  projectId: string
}

interface TaskRecord {
  id: string
  runId: string
  projectId: string
  model: string
  title: string
  goal: string
  steps: string[]
  status: string
  createdAt: string
}

export async function createTask({ taskId, runId, prompt, command, model, projectId }: CreateTaskParams): Promise<TaskRecord> {
  const title = buildTaskTitle({ prompt, command })

  const task: TaskRecord = {
    id: taskId,
    runId,
    projectId,
    model,
    title,
    goal: buildTaskGoal({ prompt, command }),
    steps: buildInitialTaskSteps({ prompt, command }),
    status: "active",
    createdAt: new Date().toISOString()
  }

  await saveTask(task as never)
  return task
}

function buildTaskTitle({ prompt, command }: { prompt: string; command?: string }): string {
  if (command === "/plan") return `Plan: ${prompt}`
  if (command === "/implement") return `Implement: ${prompt}`
  if (command === "/pull") return "Pull shared sysbase updates"
  if (command === "/stash") return `Stash: ${prompt}`
  return `Run: ${prompt}`
}

function buildTaskGoal({ prompt, command }: { prompt: string; command?: string }): string {
  if (command === "/plan") return `Generate a plan and store it in sysbase for: ${prompt}`
  if (command === "/implement") return `Implement the referenced plan: ${prompt}`
  if (command === "/pull") return "Sync shared sysbase content locally"
  if (command === "/stash") return `Archive sysbase content: ${prompt}`
  return prompt
}

function buildInitialTaskSteps({ command }: { prompt: string; command?: string }): string[] {
  if (command === "/plan") {
    return ["Inspect project context", "Generate plan", "Write plan into sysbase", "Complete task"]
  }
  if (command === "/implement") {
    return ["Load referenced plan", "Inspect relevant repo structure", "Implement required files and changes", "Update project knowledge", "Complete task"]
  }
  if (command === "/pull") {
    return ["Fetch shared sysbase data", "Write local sysbase files", "Complete task"]
  }
  if (command === "/stash") {
    return ["Locate target sysbase content", "Move content to archive", "Complete task"]
  }
  return ["Inspect repository state", "Determine required file, folder, and command actions", "Execute implementation steps", "Update project knowledge", "Complete task"]
}
