import fs from "node:fs/promises"
import path from "node:path"
import { getProjectMemories } from "../store/memory.js"
import { getToolResults } from "../store/tool-results.js"

/**
 * Load fix files from sysbase/fixes/ so the AI is aware of past mistakes.
 * Returns a string summary or null if no fixes exist.
 */
async function loadFixFiles(sysbasePath) {
  if (!sysbasePath) return null
  try {
    const fixesDir = path.join(sysbasePath, "fixes")
    const files = await fs.readdir(fixesDir).catch(() => [])
    if (files.length === 0) return null

    // Load the most recent 10 fix files
    const mdFiles = files.filter((f) => f.endsWith(".md")).sort().reverse().slice(0, 10)
    if (mdFiles.length === 0) return null

    const entries = []
    for (const file of mdFiles) {
      const content = await fs.readFile(path.join(fixesDir, file), "utf8")
      entries.push(content.trim())
    }

    return "PAST FIXES AND LESSONS (do NOT repeat these mistakes):\n\n" + entries.join("\n---\n")
  } catch {
    return null
  }
}

export async function loadProjectContext({
  projectId,
  command,
  prompt,
  model,
  cwd,
  sysbasePath,
  task
}) {
  const memories = await getProjectMemories(projectId)
  const fixes = await loadFixFiles(sysbasePath)

  const projectMemory = memories.length > 0
    ? memories
    : [
        "Use sysbase as the shared project support folder.",
        "Prefer creating missing folders and files when repo is empty."
      ]

  // Append fixes to project memory so the AI sees them
  if (fixes) {
    projectMemory.push(fixes)
  }

  return {
    projectId,
    command,
    prompt,
    model,
    cwd,
    sysbasePath,
    task,
    projectMemory,
    supportFolders: {
      sysbase: sysbasePath
    }
  }
}

export async function loadRunContext({ runId, taskId, projectId, cwd, sysbasePath }) {
  const previousToolResults = await getToolResults(runId)

  return {
    runId,
    taskId,
    projectId,
    cwd,
    sysbasePath,
    previousToolResults
  }
}
