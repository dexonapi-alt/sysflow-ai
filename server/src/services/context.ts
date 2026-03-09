import fs from "node:fs/promises"
import path from "node:path"
import { getProjectMemories } from "../store/memory.js"
import { getToolResults } from "../store/tool-results.js"

async function loadFixFiles(sysbasePath: string | undefined): Promise<string | null> {
  if (!sysbasePath) return null
  try {
    const fixesDir = path.join(sysbasePath, "fixes")
    const files = await fs.readdir(fixesDir).catch(() => [] as string[])
    if (files.length === 0) return null

    const mdFiles = files.filter((f) => f.endsWith(".md")).sort().reverse().slice(0, 10)
    if (mdFiles.length === 0) return null

    const entries: string[] = []
    for (const file of mdFiles) {
      const content = await fs.readFile(path.join(fixesDir, file), "utf8")
      entries.push(content.trim())
    }

    return "PAST FIXES AND LESSONS (do NOT repeat these mistakes):\n\n" + entries.join("\n---\n")
  } catch {
    return null
  }
}

interface LoadProjectContextParams {
  projectId: string
  command?: string
  prompt: string
  model: string
  cwd: string
  sysbasePath?: string
  task: unknown
}

export async function loadProjectContext({ projectId, command, prompt, model, cwd, sysbasePath, task }: LoadProjectContextParams): Promise<Record<string, unknown>> {
  const memories = await getProjectMemories(projectId)
  const fixes = await loadFixFiles(sysbasePath)

  const projectMemory: unknown[] = memories.length > 0
    ? memories
    : [
        "Use sysbase as the shared project support folder.",
        "Prefer creating missing folders and files when repo is empty."
      ]

  if (fixes) {
    projectMemory.push(fixes)
  }

  return {
    projectId, command, prompt, model, cwd, sysbasePath, task,
    projectMemory,
    supportFolders: { sysbase: sysbasePath }
  }
}

interface LoadRunContextParams {
  runId: string
  taskId: string
  projectId: string
  cwd: string
  sysbasePath?: string
}

export async function loadRunContext({ runId, taskId, projectId, cwd, sysbasePath }: LoadRunContextParams): Promise<Record<string, unknown>> {
  const previousToolResults = await getToolResults(runId)

  return { runId, taskId, projectId, cwd, sysbasePath, previousToolResults }
}
