import * as React from "react"
import { Box, Static, Text } from "ink"
import { useAgentEvents } from "../hooks/useAgentEvents.js"
import { Spinner } from "./Spinner.js"
import { palette } from "../theme.js"

/**
 * Renders the agent's output stream as Ink components.
 *
 * Past log lines go through Ink's <Static> so they aren't re-rendered every
 * frame — that's how Ink avoids the "infinite scroll redraw" performance
 * trap. The live region (current spinner) lives in a regular <Box> below
 * and updates per event.
 *
 * Stage 3 keeps the rendered shape close to the legacy console.log output
 * so users won't notice a format change. Later stages introduce purpose-
 * built TaskList / ToolStep / StructuredDiff components.
 */
export function AgentStream(): React.ReactElement {
  const { log, spinnerText } = useAgentEvents()

  return (
    <Box flexDirection="column">
      <Static items={log}>
        {(entry) => (
          <Box key={entry.id}>
            <Text color={colorFor(entry.level)}>{entry.text}</Text>
          </Box>
        )}
      </Static>
      {spinnerText !== null && (
        <Box marginTop={0}>
          <Spinner text={spinnerText || undefined} />
        </Box>
      )}
    </Box>
  )
}

function colorFor(level: string): string | undefined {
  switch (level) {
    case "muted":   return palette.muted
    case "success": return palette.success
    case "warning": return palette.warning
    case "error":   return palette.error
    case "accent":  return palette.accent
    case "info":
    default:        return undefined
  }
}
