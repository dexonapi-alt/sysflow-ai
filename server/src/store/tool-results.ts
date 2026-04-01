import { query } from "../db/connection.js"

interface ToolResultRecord {
  tool: string
  result: Record<string, unknown>
  timestamp: string
}

/**
 * Save a tool result to the database.
 * Stores a COMPRESSED version — strips raw file content to keep DB lean.
 */
export async function saveToolResult(runId: string, tool: string, result: Record<string, unknown>): Promise<void> {
  const compressed = compressToolResult(tool, result)
  await query(
    `INSERT INTO tool_results (run_id, tool, result) VALUES ($1, $2, $3)`,
    [runId, tool, JSON.stringify(compressed)]
  )
}

export async function getToolResults(runId: string): Promise<ToolResultRecord[]> {
  const res = await query(
    `SELECT tool, result, created_at FROM tool_results WHERE run_id = $1 ORDER BY created_at ASC`,
    [runId]
  )

  return res.rows.map((row) => ({
    tool: row.tool,
    result: typeof row.result === "string" ? JSON.parse(row.result) : row.result,
    timestamp: row.created_at
  }))
}

/**
 * Compress a tool result for storage.
 * Strips large payloads (file content, directory listings) to summaries.
 * This prevents context bloat when results are loaded back as previousToolResults.
 */
function compressToolResult(tool: string, result: Record<string, unknown>): Record<string, unknown> {
  // Keep error results as-is (they're small and important)
  if (result.error) {
    return { ...result, error: (result.error as string).slice(0, 300) }
  }

  switch (tool) {
    case "read_file": {
      const content = result.content as string | undefined
      const totalLines = result.totalLines as number | undefined
      if (!content) return { path: result.path, success: true, summary: "(empty)" }
      const lines = content.split("\n")
      const truncated = lines.length > 200
        ? lines.slice(0, 200).join("\n") + "\n... (truncated)"
        : content
      return {
        path: result.path,
        success: true,
        content: truncated.length > 8000 ? truncated.slice(0, 8000) + "\n... (truncated)" : truncated,
        summary: `${totalLines ?? lines.length} total lines, ${content.length} chars${result.truncated ? " (truncated)" : ""}`
      }
    }

    case "batch_read": {
      const files = result.files as Array<{ path: string; content?: string; error?: string; success: boolean }> | undefined
      return {
        files: files?.map((f) => ({
          path: f.path,
          success: f.success,
          summary: f.success && f.content
            ? `${f.content.split("\n").length} lines`
            : f.error?.slice(0, 100) || "(empty)"
        }))
      }
    }

    case "write_file":
      return { path: result.path, success: result.success }

    case "edit_file":
      return { path: result.path, success: result.success }

    case "list_directory": {
      const entries = result.entries as string[] | undefined
      return {
        path: result.path,
        count: entries?.length || 0,
        entries: entries?.slice(0, 20),
        truncated: (entries?.length || 0) > 20
      }
    }

    case "run_command": {
      const out: Record<string, unknown> = {
        command: result.command,
        success: result.success !== false && !result.error
      }
      if (result.skipped) out.skipped = true
      if (result.stderr) out.stderr = (result.stderr as string).slice(-200)
      if (result.stdout) out.stdout = (result.stdout as string).slice(-300)
      if (result.message) out.message = (result.message as string).slice(0, 200)
      return out
    }

    case "search_code":
    case "search_files": {
      const matches = (result.matches || result.results) as unknown[] | undefined
      return {
        pattern: result.pattern || result.query,
        matchCount: matches?.length || 0,
        matches: matches?.slice(0, 10)
      }
    }

    default:
      return result
  }
}
