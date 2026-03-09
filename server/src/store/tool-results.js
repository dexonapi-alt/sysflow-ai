const toolResults = new Map()

export async function saveToolResult(runId, tool, result) {
  if (!toolResults.has(runId)) {
    toolResults.set(runId, [])
  }

  toolResults.get(runId).push({
    tool,
    result,
    timestamp: new Date().toISOString()
  })
}

export async function getToolResults(runId) {
  return toolResults.get(runId) || []
}
