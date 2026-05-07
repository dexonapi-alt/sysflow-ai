import * as React from "react"
import { Box, Static, Text } from "ink"
import { useAgentEvents } from "../hooks/useAgentEvents.js"
import { Spinner } from "./Spinner.js"
import { ActionCard } from "./ActionCard.js"
import { ReasoningPeek } from "./ReasoningPeek.js"
import { Typewriter } from "../animation/primitives/index.js"
import { palette } from "../theme.js"

/**
 * Renders the agent's output stream as Ink components.
 *
 * Past log lines go through Ink's <Static> so they aren't re-rendered every
 * frame — that's how Ink avoids the "infinite scroll redraw" performance
 * trap. The live region (current spinner + active tool cards) lives in a
 * regular <Box> below and updates per event.
 *
 * Phase 12 Stage 4 introduced living tool cards; Phase 14 Stage 2 replaced
 * the bordered <ToolCard> with the cleaner <ActionCard> (Claude-style
 * `● Verb(target)` single-line render, no surrounding box). Settled cards
 * still join the <Static> region so their breath ticks stop — only the
 * actively-running card and the spinner re-render each frame.
 */
export function AgentStream(): React.ReactElement {
  const { log, spinnerText, toolCards, assistantMessage, reasoningBrief } = useAgentEvents()

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
            <ActionCard card={card} />
          </Box>
        )}
      </Static>
      {runningCards.map((card) => (
        <Box key={card.id} marginTop={0}>
          <ActionCard card={card} />
        </Box>
      ))}
      {/*
        Phase 12 Stage 6: assistant completion text reveals via <Typewriter>
        in the live region above the spinner. Keyed on assistantMessage.key
        so each new emission re-mounts the Typewriter and re-triggers the
        reveal — important when the text repeats (e.g. /continue from a
        prior chunk's identical summary).
      */}
      {assistantMessage && (
        <Box marginTop={1}>
          <Text color={palette.muted}>  </Text>
          <Typewriter key={assistantMessage.key} wpm={250} color={palette.bright}>
            {assistantMessage.text}
          </Typewriter>
        </Box>
      )}
      {/*
        Phase 14 Stage 4: surface the latest reasoning brief above the
        spinner so the user sees WHAT the agent reasoned about while it's
        still working through the next chunk. Stays mounted until the
        next `clear` event (new prompt).
      */}
      {reasoningBrief && (
        <ReasoningPeek brief={reasoningBrief} />
      )}
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
