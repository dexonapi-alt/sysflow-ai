import { useEffect, useState } from "react"
import { onAgent, type LogLevel } from "../../agent/events.js"

interface LogLine {
  id: number
  level: LogLevel
  text: string
}

interface State {
  /** Past log lines, append-only — rendered via Ink <Static> for cheap scroll. */
  log: LogLine[]
  /** Current spinner text — null when no work is in progress. */
  spinnerText: string | null
}

let nextId = 1

/**
 * Subscribes to the agent event bus and exposes the current view state.
 * One subscription per consumer — components compose the parts they need.
 */
export function useAgentEvents(): State {
  const [state, setState] = useState<State>({ log: [], spinnerText: null })

  useEffect(() => {
    return onAgent((event) => {
      setState((prev) => {
        switch (event.type) {
          case "clear":
            return { log: [], spinnerText: null }
          case "log":
            return {
              ...prev,
              log: [...prev.log, { id: nextId++, level: event.level, text: event.text }],
            }
          case "spinner":
            return { ...prev, spinnerText: event.text }
          case "spinner_stop":
            return { ...prev, spinnerText: null }
          case "complete":
            return { ...prev, spinnerText: null }
          default:
            return prev
        }
      })
    })
  }, [])

  return state
}
