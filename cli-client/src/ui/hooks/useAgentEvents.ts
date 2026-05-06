import { useEffect, useState } from "react"
import { onAgent, type AgentEvent, type LogLevel } from "../../agent/events.js"

export interface LogLine {
  id: number
  level: LogLevel
  text: string
}

export type ToolCardStatus = "running" | "success" | "error"

export interface ToolCardState {
  /** Stable id from the matching tool_start event. */
  id: string
  /** Tool name, e.g. "write_file". */
  tool: string
  /** Human-readable label rendered in the card header. */
  label: string
  /** Lifecycle status; transitions running → success | error on tool_end. */
  status: ToolCardStatus
  /** Wall-clock millis when the card mounted. Used by ToolCard to drive
   *  fade-in + the Pulse trigger key on settle. */
  startedAt: number
  /** Optional error message, set when status === "error". */
  error?: string
}

export interface AgentEventState {
  /** Past log lines, append-only — rendered via Ink <Static> for cheap scroll. */
  log: LogLine[]
  /** Current spinner text — null when no work is in progress. */
  spinnerText: string | null
  /** Phase 12 Stage 4: tool cards in mount order. Cards persist after
   *  tool_end so they remain visible in the stream. */
  toolCards: ToolCardState[]
}

const INITIAL: AgentEventState = { log: [], spinnerText: null, toolCards: [] }

let nextLogId = 1

/**
 * Pure reducer over (state, event). Exported separately from the hook so
 * the state-transition contract is unit-testable without React. Stage 4
 * tests target this function directly; the hook is just thin glue.
 *
 * Designed to be additive: an unknown event type falls through and the
 * state is returned unchanged so future event additions don't crash
 * existing consumers.
 */
export function reduceAgentEvent(prev: AgentEventState, event: AgentEvent): AgentEventState {
  switch (event.type) {
    case "clear":
      // Wipe everything for a fresh prompt — old log lines and any
      // lingering tool cards from the previous run shouldn't show up.
      return INITIAL
    case "log":
      return {
        ...prev,
        log: [...prev.log, { id: nextLogId++, level: event.level, text: event.text }],
      }
    case "spinner":
      return { ...prev, spinnerText: event.text }
    case "spinner_stop":
    case "complete":
      return { ...prev, spinnerText: null }
    case "tool_start": {
      // Defensive: ignore a duplicate start with the same id (would otherwise
      // produce two cards for one tool call).
      if (prev.toolCards.some((c) => c.id === event.id)) return prev
      const card: ToolCardState = {
        id: event.id,
        tool: event.tool,
        label: event.label,
        status: "running",
        startedAt: Date.now(),
      }
      return { ...prev, toolCards: [...prev.toolCards, card] }
    }
    case "tool_end": {
      // Update the matching card in place. If no card exists, ignore the
      // event — likely an end-without-start (race or replay).
      const idx = prev.toolCards.findIndex((c) => c.id === event.id)
      if (idx === -1) return prev
      const next = prev.toolCards.slice()
      next[idx] = {
        ...next[idx],
        status: event.ok ? "success" : "error",
        error: event.ok ? undefined : event.error,
      }
      return { ...prev, toolCards: next }
    }
    default:
      return prev
  }
}

/** Test-only: reset the auto-incrementing log id counter. */
export function _resetIdsForTests(): void {
  nextLogId = 1
}

/**
 * Subscribes to the agent event bus and exposes the current view state.
 * One subscription per consumer — components compose the parts they need.
 */
export function useAgentEvents(): AgentEventState {
  const [state, setState] = useState<AgentEventState>(INITIAL)

  useEffect(() => {
    return onAgent((event) => {
      setState((prev) => reduceAgentEvent(prev, event))
    })
  }, [])

  return state
}
