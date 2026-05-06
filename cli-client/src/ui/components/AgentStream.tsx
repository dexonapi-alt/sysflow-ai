import * as React from "react"
import { Box, Static, Text } from "ink"
import { useAgentEvents } from "../hooks/useAgentEvents.js"
import { Spinner } from "./Spinner.js"
import { ToolCard } from "./ToolCard.js"
import { palette } from "../theme.js"

/**
 * Renders the agent's output stream as Ink components.
 *
 * Past log lines go through Ink's <Static> so they aren't re-rendered every
 * frame — that's how Ink avoids the "infinite scroll redraw" performance
 * trap. The live region (current spinner + active tool cards) lives in a
 * regular <Box> below and updates per event.
 *
 * Phase 12 Stage 4: tool calls are now rendered as living <ToolCard>
 * components. Settled cards (success / error) join the static region so
 * their internal Shimmer / Pulse animations stop ticking — only the
 * actively-running card and the spinner re-render each frame.
 */
export function AgentStream(): React.ReactElement {
  const { log, spinnerText, toolCards } = useAgentEvents()

  // Partition cards: settled ones go to <Static> (no per-frame redraw),
  // the in-flight one (if any) stays in the live region. There's at most
  // one running card at a time in the chunked-loop's serialised dispatch
  // path, but the partition tolerates multiples (e.g. parallel batches).
  const settledCards = toolCards.filter((c) => c.status !== "running")
  const runningCards = toolCards.filter((c) => c.status === "running")

  return (
    <Box flexDirection="column">
      <Static items={log}>
        {(entry) => (
          <Box key={entry.id}>
            <Text color={colorFor(entry.level)}>{entry.text}</Text>
          </Box>
        )}
      </Static>
      <Static items={settledCards}>
        {(card) => (
          <Box key={card.id} marginTop={0}>
            <ToolCard card={card} />
          </Box>
        )}
      </Static>
      {runningCards.map((card) => (
        <Box key={card.id} marginTop={0}>
          <ToolCard card={card} />
        </Box>
      ))}
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
