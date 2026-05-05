/**
 * Agent → UI event bus.
 *
 * Lets the agent loop in `agent.ts` emit lifecycle events that the Ink UI
 * (or any other renderer) subscribes to. In legacy console mode the agent
 * still uses `console.log`; in `SYS_INK=1` mode it emits events instead and
 * `<AgentStream>` renders them in place.
 *
 * Event types are deliberately coarse: `log` covers most one-shot output
 * (tool call labels, status messages, errors) and `spinner` / `spinner_stop`
 * mirror the ora spinner API the agent already uses. Stage 3 intentionally
 * keeps the surface small; later stages add structured task / diff / brief
 * events as we port more of agent.ts off console.log.
 */

import { EventEmitter } from "node:events"

export type LogLevel = "info" | "muted" | "success" | "warning" | "error" | "accent"

export type AgentEvent =
  | { type: "clear" }
  | { type: "log"; level: LogLevel; text: string }
  | { type: "spinner"; text: string }
  | { type: "spinner_stop" }
  | { type: "complete" }

const emitter = new EventEmitter()
emitter.setMaxListeners(20)

const CHANNEL = "event"

export function emitAgent(event: AgentEvent): void {
  emitter.emit(CHANNEL, event)
}

export function onAgent(handler: (event: AgentEvent) => void): () => void {
  emitter.on(CHANNEL, handler)
  return () => emitter.off(CHANNEL, handler)
}

/** True when the runtime should emit events instead of writing to the console. */
export function isInkActive(): boolean {
  return process.env.SYS_INK === "1"
}
