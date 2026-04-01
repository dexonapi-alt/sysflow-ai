import { query } from "../db/connection.js"

const MAX_SESSIONS_IN_PROMPT = 20

interface RunActionLog {
  actions: Array<Record<string, unknown>>
  filesModified: string[]
  errors: Array<{ tool: string; error: string; actionIndex: number }>
  projectId: string
}

interface SessionEntry {
  runId: string
  prompt: string
  model: string
  outcome?: string
  error?: string | null
  filesModified?: string[]
  userId?: string | null
  chatId?: string | null
}

interface SessionRecord {
  runId: string
  prompt: string
  model: string
  outcome: string
  error: string | null
  filesModified: string[]
  actions: Array<{ tool: string; path?: string; command?: string; output?: string; skipped?: boolean }>
  timestamp: string
}

const runActions = new Map<string, RunActionLog>()

export function recordRunAction(runId: string, tool: string, args: Record<string, unknown>, projectId: string): void {
  if (!runActions.has(runId)) {
    runActions.set(runId, { actions: [], filesModified: [], errors: [], projectId })
  }

  const log = runActions.get(runId)!

  const action: Record<string, unknown> = { tool }
  if (args?.path) action.path = args.path
  if (args?.command) action.command = (args.command as string)?.slice(0, 120)
  if (args?.from) action.from = args.from
  if (args?.to) action.to = args.to
  if (tool === "run_command") {
    if (args?.stdout) action.output = (args.stdout as string).slice(-500)
    if (args?.stderr) action.stderr = (args.stderr as string).slice(-300)
    if (args?.skipped) action.skipped = true
    if (args?.message) action.message = (args.message as string).slice(0, 200)
  }
  if (tool === "read_file" && args?.content) {
    action.contentPreview = (args.content as string).slice(0, 200)
  }
  if (tool === "_user_response" && args?.answer) {
    action.answer = (args.answer as string).slice(0, 500)
  }
  log.actions.push(action)

  if ((tool === "write_file" || tool === "edit_file") && args?.path) {
    if (!log.filesModified.includes(args.path as string)) {
      log.filesModified.push(args.path as string)
    }
  }

  const result = args
  if (result?.error || result?.stderr || result?.success === false) {
    const errMsg = result.error || result.stderr || "Tool returned failure"
    log.errors.push({ tool, error: typeof errMsg === "string" ? errMsg.slice(0, 300) : String(errMsg).slice(0, 300), actionIndex: log.actions.length - 1 })
  }

  query(
    `INSERT INTO run_actions (run_id, project_id, tool, path, command, extra)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      runId,
      projectId || log.projectId,
      tool,
      (action.path as string) || null,
      (action.command as string) || null,
      JSON.stringify(action)
    ]
  ).catch((err) => console.error("[sessions] Failed to save run action:", (err as Error).message))
}

export function getRunActions(runId: string): RunActionLog {
  return runActions.get(runId) || { actions: [], filesModified: [], errors: [], projectId: "" }
}

export function clearRunActions(runId: string): void {
  runActions.delete(runId)
}

export async function saveSessionEntry(projectId: string, entry: SessionEntry): Promise<void> {
  await query(
    `INSERT INTO sessions (run_id, project_id, prompt, model, outcome, error, files_modified, user_id, chat_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      entry.runId,
      projectId,
      entry.prompt,
      entry.model,
      entry.outcome || "unknown",
      entry.error || null,
      entry.filesModified || [],
      entry.userId || null,
      entry.chatId || null
    ]
  )
}

export async function getRecentSessions(projectId: string, chatId?: string | null, limit?: number): Promise<SessionRecord[]> {
  const count = limit || MAX_SESSIONS_IN_PROMPT

  let res
  if (chatId) {
    res = await query(
      `SELECT s.run_id, s.prompt, s.model, s.outcome, s.error, s.files_modified, s.created_at
       FROM sessions s
       WHERE s.project_id = $1 AND s.chat_id = $2
       ORDER BY s.created_at DESC
       LIMIT $3`,
      [projectId, chatId, count]
    )
  } else {
    res = await query(
      `SELECT s.run_id, s.prompt, s.model, s.outcome, s.error, s.files_modified, s.created_at
       FROM sessions s
       WHERE s.project_id = $1
       ORDER BY s.created_at DESC
       LIMIT $2`,
      [projectId, count]
    )
  }

  const sessions: SessionRecord[] = []
  for (const row of res.rows.reverse()) {
    const actionsRes = await query(
      `SELECT tool, path, command FROM run_actions WHERE run_id = $1 ORDER BY created_at`,
      [row.run_id]
    )

    sessions.push({
      runId: row.run_id,
      prompt: row.prompt,
      model: row.model,
      outcome: row.outcome,
      error: row.error,
      filesModified: row.files_modified || [],
      actions: actionsRes.rows.map((a: Record<string, unknown>) => ({ tool: a.tool as string, path: a.path as string | undefined, command: a.command as string | undefined })),
      timestamp: row.created_at
    })
  }

  return sessions
}

export async function getLastSession(projectId: string, chatId?: string | null): Promise<SessionRecord | null> {
  const sessions = await getRecentSessions(projectId, chatId, 1)
  return sessions.length > 0 ? sessions[0] : null
}

export async function saveOrphanedSessions(projectId: string, chatId?: string | null): Promise<void> {
  try {
    const res = await query(
      `SELECT DISTINCT ra.run_id, MIN(ra.created_at) as first_action
       FROM run_actions ra
       WHERE ra.project_id = $1
         AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.run_id = ra.run_id)
       GROUP BY ra.run_id
       ORDER BY first_action`,
      [projectId]
    )

    for (const row of res.rows) {
      const actionsRes = await query(
        `SELECT tool, path, command FROM run_actions WHERE run_id = $1 ORDER BY created_at`,
        [row.run_id]
      )

      const actions = actionsRes.rows as Array<{ tool: string; path?: string }>
      const filesModified = actions
        .filter((a) => a.tool === "write_file" || a.tool === "edit_file")
        .map((a) => a.path)
        .filter(Boolean) as string[]

      const actionSummary = actions.map((a) => a.tool + (a.path ? ` ${a.path}` : "")).join(", ")

      await saveSessionEntry(projectId, {
        runId: row.run_id,
        prompt: `(interrupted) actions: ${actionSummary}`,
        model: "unknown",
        outcome: "interrupted",
        error: "Run was interrupted before completion",
        filesModified,
        userId: null,
        chatId: chatId || null
      })

      console.log(`[sessions] Saved orphaned run ${row.run_id} as interrupted session`)
    }
  } catch (err) {
    console.error("[sessions] Failed to save orphaned sessions:", (err as Error).message)
  }
}

export async function buildSessionSummary(projectId: string, chatId?: string | null): Promise<string | null> {
  const recent = await getRecentSessions(projectId, chatId)
  if (recent.length === 0) return null

  // ─── Compressed session summary ───
  // Instead of dumping every action from 20 sessions, we compress to:
  // 1. One-line-per-session overview (last 5 in detail, older ones just counted)
  // 2. Aggregate file state (all files touched, marked unverified)
  // 3. User decisions extracted
  // 4. Last error

  const lines: string[] = []

  // Older sessions: just count them
  const older = recent.slice(0, -5)
  const recentFive = recent.slice(-5)
  if (older.length > 0) {
    const olderCompleted = older.filter((s) => s.outcome === "completed").length
    const olderFailed = older.filter((s) => s.outcome !== "completed").length
    lines.push(`Previous sessions (${older.length} older): ${olderCompleted} completed, ${olderFailed} failed/interrupted`)
  }

  // Recent sessions: one line each with key actions only (writes, commands — skip reads)
  if (recentFive.length > 0) {
    lines.push("Recent sessions:")
    for (const session of recentFive) {
      const tag = session.outcome === "completed" ? "✓" : session.outcome === "failed" ? "✗" : "⚡"
      const errNote = session.error ? ` — FAILED: ${session.error.slice(0, 120)}` : ""
      lines.push(`  ${tag} "${session.prompt.slice(0, 100)}"${errNote}`)

      // Only show write/edit/command actions (skip reads — they're noise)
      const keyActions = session.actions.filter((a) =>
        a.tool === "write_file" || a.tool === "edit_file" || a.tool === "run_command" ||
        a.tool === "create_directory" || a.tool === "delete_file" || a.tool === "_user_response"
      )
      if (keyActions.length > 0) {
        const actionStr = keyActions.slice(0, 8).map((a) => {
          if (a.tool === "run_command") return `run "${(a.command || "").slice(0, 50)}"`
          if (a.tool === "_user_response") return `user answered`
          return `${a.tool.replace("_file", "")} ${a.path || ""}`
        }).join(", ")
        lines.push(`    → ${actionStr}${keyActions.length > 8 ? ` +${keyActions.length - 8} more` : ""}`)
      }
    }
  }

  // Aggregate files touched (unverified)
  const allFiles = new Set<string>()
  for (const s of recent) {
    for (const f of s.filesModified) allFiles.add(f)
  }
  if (allFiles.size > 0) {
    const fileList = [...allFiles].slice(0, 25).join(", ")
    lines.push(`\nFiles from history (UNVERIFIED — may be deleted/changed): ${fileList}${allFiles.size > 25 ? ` +${allFiles.size - 25} more` : ""}`)
  }

  // User decisions
  const decisions: string[] = []
  for (const s of recent) {
    for (const a of s.actions) {
      const answer = (a as Record<string, unknown>).answer as string | undefined
      if (a.tool === "_user_response" && answer && !decisions.includes(answer)) {
        decisions.push(answer)
      }
    }
  }
  if (decisions.length > 0) {
    lines.push(`\nUser decisions (do NOT re-ask): ${decisions.map((d) => `"${d}"`).join(", ")}`)
  }

  return lines.join("\n")
}

export async function buildContinueContext(projectId: string, chatId?: string | null): Promise<string | null> {
  const recent = await getRecentSessions(projectId, chatId, 10)
  if (recent.length === 0) return null

  // ─── Compressed continuation context ───
  // Extract ONLY what matters for continuing:
  // 1. Original task
  // 2. What files exist (unverified)
  // 3. User decisions
  // 4. Last error
  // 5. What was completed vs. what's remaining
  // Skip: read_file actions, raw command output, per-step breakdowns

  const allFilesCreated = new Set<string>()
  const userDecisions: string[] = []
  let lastError: string | null = null
  const completedTasks: string[] = []
  const failedTasks: string[] = []
  let scaffoldDir: string | null = null

  // Scaffold command patterns for directory extraction
  const scaffoldCmdPatterns = [
    /create-vite\S*\s+(\S+)/, /create-next-app\S*\s+(\S+)/,
    /create-react-app\S*\s+(\S+)/, /@nestjs\/cli\s+new\s+(\S+)/,
    /@angular\/cli\s+new\s+(\S+)/, /nuxi\S*\s+init\s+(\S+)/,
  ]

  for (const session of recent) {
    for (const f of session.filesModified) allFilesCreated.add(f)

    for (const a of session.actions) {
      const answer = (a as Record<string, unknown>).answer as string | undefined
      if (a.tool === "_user_response" && answer && !userDecisions.includes(answer)) {
        userDecisions.push(answer)
      }
      // Detect scaffold commands to find the scaffold directory
      if (a.tool === "run_command" && a.command) {
        for (const pat of scaffoldCmdPatterns) {
          const m = a.command.match(pat)
          if (m && m[1] && m[1] !== "." && !m[1].startsWith("-")) {
            scaffoldDir = m[1]
          }
        }
      }
    }

    if (session.error) lastError = session.error

    if (session.outcome === "completed") {
      completedTasks.push(session.prompt.slice(0, 80))
    } else if (session.outcome === "failed") {
      failedTasks.push(`${session.prompt.slice(0, 60)}: ${(session.error || "unknown error").slice(0, 80)}`)
    }
  }

  const originalPrompt = recent.length > 0 ? recent[recent.length - 1].prompt : null
  const lastPrompt = recent[0]?.prompt || null

  // Detect working directory from file paths
  const allFiles = [...allFilesCreated]
  let workingDir = "."
  if (allFiles.length > 0) {
    // Find the most common top-level directory prefix
    const prefixCounts = new Map<string, number>()
    for (const f of allFiles) {
      const parts = f.replace(/\\/g, "/").split("/")
      if (parts.length > 1 && parts[0] !== "src" && parts[0] !== "public" && !parts[0].includes(".")) {
        const prefix = parts[0]
        prefixCounts.set(prefix, (prefixCounts.get(prefix) || 0) + 1)
      } else {
        prefixCounts.set(".", (prefixCounts.get(".") || 0) + 1)
      }
    }
    // If most files are in a subdirectory, that's the working dir
    let maxCount = 0
    for (const [prefix, count] of prefixCounts) {
      if (count > maxCount) {
        maxCount = count
        workingDir = prefix
      }
    }
  }

  const lines: string[] = []
  lines.push("=== CONTINUATION CONTEXT ===")

  if (originalPrompt) {
    lines.push(`ORIGINAL GOAL: "${originalPrompt}"`)
  }
  if (lastPrompt && lastPrompt !== originalPrompt) {
    lines.push(`MOST RECENT PROMPT: "${lastPrompt}"`)
  }

  // Detect scaffold conflict: scaffold created a subdirectory but files are at root
  const hasScaffoldConflict = scaffoldDir && workingDir === "." && allFiles.some((f) => {
    const norm = f.replace(/\\/g, "/")
    return !norm.startsWith(scaffoldDir + "/")
  })

  // Working directory + scaffold conflict warning
  if (hasScaffoldConflict) {
    lines.push(`\n⚠️ SCAFFOLD CONFLICT: A scaffolding command created the "${scaffoldDir}/" directory, but the AI abandoned it and created files at the project ROOT instead.`)
    lines.push(`WORKING DIRECTORY: project root (.) — This is where the actual files are. IGNORE the "${scaffoldDir}/" directory completely. Do NOT read, write, or reference any files inside "${scaffoldDir}/".`)
    lines.push(`Continue working at the project root (src/, public/, package.json, etc).`)
  } else if (workingDir !== ".") {
    lines.push(`\nWORKING DIRECTORY: "${workingDir}/" — All previous files were created inside this directory. Continue working here. Do NOT create a new project or switch directories.`)
  } else {
    lines.push(`\nWORKING DIRECTORY: project root (.) — Files were created at the root level (src/, public/, etc). Continue working here. Do NOT create a new subdirectory or scaffold a new project.`)
  }

  // Completed work
  if (completedTasks.length > 0) {
    lines.push(`\nCompleted runs (${completedTasks.length}): ${completedTasks.slice(-3).join("; ")}`)
  }

  // Files state (unverified)
  if (allFilesCreated.size > 0) {
    const fileList = [...allFilesCreated].slice(0, 30).join(", ")
    lines.push(`\nFiles previously created (UNVERIFIED — verify before assuming they exist): ${fileList}${allFilesCreated.size > 30 ? ` +${allFilesCreated.size - 30} more` : ""}`)
  }

  // User decisions
  if (userDecisions.length > 0) {
    lines.push(`\nUser decisions (confirmed — do NOT re-ask): ${userDecisions.map((d) => `"${d}"`).join(", ")}`)
  }

  // Last error — this is CRITICAL for /continue to work properly
  if (lastError) {
    const lastFailedSession = [...recent].reverse().find((s) => s.outcome === "failed" || s.outcome === "interrupted")
    if (lastFailedSession) {
      lines.push(`\n⚠️ PREVIOUS RUN FAILED:`)
      lines.push(`  Error: ${lastError.slice(0, 300)}`)
      lines.push(`  The run was interrupted at this point. Pick up from where it stopped.`)
      if (lastFailedSession.filesModified.length > 0) {
        lines.push(`  Files created before failure: ${lastFailedSession.filesModified.slice(0, 15).join(", ")}`)
      }
      // Show what actions were taken in the failed run so the AI knows where to resume
      const lastActions = lastFailedSession.actions.slice(-5)
      if (lastActions.length > 0) {
        const actionStr = lastActions.map((a) => {
          if (a.tool === "run_command") return `run "${(a.command || "").slice(0, 50)}"`
          return `${a.tool} ${a.path || ""}`
        }).join(", ")
        lines.push(`  Last actions before failure: ${actionStr}`)
      }
    } else {
      lines.push(`\nLast error: ${lastError.slice(0, 200)}`)
    }
  }

  lines.push(`\nINSTRUCTION: Continue the original task from where the previous run stopped. Do NOT redo completed work. Do NOT re-ask decided questions. Verify files exist before assuming they do.`)

  return lines.join("\n")
}
