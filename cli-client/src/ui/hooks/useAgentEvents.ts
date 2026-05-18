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
  /** Phase 14 Stage 2: original tool args, used by <ActionCard> to derive
   *  the Claude-style `Verb(target)` header without round-tripping through
   *  the legacy `formatToolLabel` chalk-coloured string. */
  args?: Record<string, unknown>
  /** Lifecycle status; transitions running → success | error on tool_end. */
  status: ToolCardStatus
  /** Wall-clock millis when the card mounted. Used by ToolCard to drive
   *  fade-in + the Pulse trigger key on settle. */
  startedAt: number
  /** Optional error message, set when status === "error". */
  error?: string
}

/** Phase 12 Stage 5: latest awareness snapshot, mirrors the server's
 *  awarenessSnapshot payload from Phase 11. Null when awareness is
 *  disabled or no snapshot has arrived yet this run. */
export interface AwarenessSnapshot {
  state: "on_track" | "off_course" | "blocked"
  confidence: number
  lastSignal: string | null
}

/** Phase 12 Stage 5: latest chunk-plan info. `pulseKey` increments on
 *  every new chunk so the Header's Pulse re-fires. */
export interface ChunkPulseState {
  index: number
  nextAction: string
  fileCount: number
  pulseKey: number
}

/** Phase 12 Stage 6: latest assistant message. `key` increments on every
 *  new emission so the AgentStream's Typewriter re-triggers the reveal
 *  even if the text happens to repeat (defensive against duplicate
 *  emissions and a clean re-mount path on /continue). */
export interface AssistantMessageState {
  text: string
  key: number
}

/** Phase 14 Stage 4: latest reasoning brief surfaced by a Flash call.
 *  The renderer (`<ReasoningPeek>`) reads this via the hook and renders
 *  pipeline-specific summary lines so the user sees the agent's thinking
 *  inline instead of after the fact. `key` increments per emission so
 *  duplicate briefs (e.g. cache hit + cache miss for same prompt) still
 *  trigger a re-render. */
export interface ReasoningBriefState {
  kind: string
  briefData: Record<string, unknown> | undefined
  key: number
}

export interface AgentEventState {
  /** Past log lines, append-only — rendered via Ink <Static> for cheap scroll. */
  log: LogLine[]
  /** Current spinner text — null when no work is in progress. */
  spinnerText: string | null
  /** Phase 12 Stage 4: tool cards in mount order. Cards persist after
   *  tool_end so they remain visible in the stream. */
  toolCards: ToolCardState[]
  /** Phase 12 Stage 5: latest awareness snapshot, drives Header badge. */
  awareness: AwarenessSnapshot | null
  /** Phase 12 Stage 5: latest chunk-plan, drives Header chunk pulse. */
  chunk: ChunkPulseState | null
  /** Phase 12 Stage 6: latest assistant message, rendered via Typewriter
   *  in the live region of AgentStream. */
  assistantMessage: AssistantMessageState | null
  /** Phase 14 Stage 4: latest reasoning brief, rendered as ReasoningPeek
   *  in the live region above the spinner. */
  reasoningBrief: ReasoningBriefState | null
  /** Phase 16-fixup (Bug 5): wall-clock millis when this run started.
   *  Set on the first `spinner` event after a `clear`; survives
   *  spinner_stop / spinner re-mounts between chunks so RichSpinner's
   *  elapsed clock keeps counting until the run actually finishes.
   *  Cleared on `clear` and `complete`. */
  runStartedAt: number | null
  /** Phase 19: intent classification result for the current run, set
   *  by an `intent_classified` event after the preflight classifier
   *  runs. Drives the <AgentStream> gate that hides the task box for
   *  non-implement runs (`simple` Q&A, `summary`, `bug`). Most-recent
   *  wins; `clear` wipes it for a fresh prompt. */
  runIntent: "simple" | "summary" | "bug" | "implement" | null
  /** Stage 4 of plan 2026-05-18-ui-ux-polish-and-action-aware-spinner.md
   *  (audit issue #1): sysflow-infrastructure error banner. Set when
   *  `agent.ts` emits the `infra_error` event on a terminal-exit reason
   *  of `sysflow_infra`. The <AgentStream> renders an <ErrorBanner>
   *  block in the live region. Null when no infra error fired. */
  infraError: { title: string; message: string; hint: string | null } | null
}

const INITIAL: AgentEventState = { log: [], spinnerText: null, toolCards: [], awareness: null, chunk: null, assistantMessage: null, reasoningBrief: null, runStartedAt: null, runIntent: null, infraError: null }

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
    case "spinner": {
      // Phase 16-fixup (Bug 5): start the run-level timer on the first
      // spinner of a fresh run. Subsequent spinner events (between
      // chunks, between phases) preserve the original start so
      // RichSpinner's elapsed clock counts the WHOLE run, not just
      // the current spinner instance's lifetime.
      const runStartedAt = prev.runStartedAt ?? Date.now()
      return { ...prev, spinnerText: event.text, runStartedAt }
    }
    case "spinner_stop":
      // Spinner stops between chunks but the run isn't done yet; keep
      // runStartedAt so the next spinner picks up where the old one left.
      return { ...prev, spinnerText: null }
    case "complete":
      // Run is finished — clear the timer along with the spinner text so
      // a stale "elapsed" doesn't keep ticking after the run ends.
      return { ...prev, spinnerText: null, runStartedAt: null }
    case "tool_start": {
      // Defensive: ignore a duplicate start with the same id (would otherwise
      // produce two cards for one tool call).
      if (prev.toolCards.some((c) => c.id === event.id)) return prev
      const card: ToolCardState = {
        id: event.id,
        tool: event.tool,
        label: event.label,
        args: event.args,
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
    case "awareness_update":
      return {
        ...prev,
        awareness: {
          state: event.state,
          confidence: event.confidence,
          lastSignal: event.lastSignal ?? null,
        },
      }
    case "chunk_plan": {
      // pulseKey increments per chunk so the Header's <Pulse> re-fires
      // even when the chunkIndex appears to repeat (defensive against
      // duplicate emissions).
      const prevKey = prev.chunk?.pulseKey ?? 0
      return {
        ...prev,
        chunk: {
          index: event.chunkIndex,
          nextAction: event.nextAction,
          fileCount: event.fileCount ?? 0,
          pulseKey: prevKey + 1,
        },
      }
    }
    case "assistant_message": {
      // Defensive: ignore non-string / empty messages so a malformed
      // emission never produces an empty Typewriter (which would briefly
      // render nothing then "vanish" — confusing).
      if (typeof event.text !== "string" || event.text.length === 0) return prev
      const prevKey = prev.assistantMessage?.key ?? 0
      return {
        ...prev,
        assistantMessage: { text: event.text, key: prevKey + 1 },
      }
    }
    case "reasoning_brief": {
      // Defensive: ignore briefs without a kind — the renderer keys off it
      // to choose the summary shape and a missing kind would render blank.
      if (typeof event.kind !== "string" || event.kind.length === 0) return prev
      const prevKey = prev.reasoningBrief?.key ?? 0
      return {
        ...prev,
        reasoningBrief: { kind: event.kind, briefData: event.briefData, key: prevKey + 1 },
      }
    }
    case "intent_classified": {
      // Defensive: ignore unknown intent values so a malformed payload
      // can't put the reducer into a non-enumerated state. The four
      // known values match the server's `IntentHint` union.
      if (
        event.intent !== "simple"
        && event.intent !== "summary"
        && event.intent !== "bug"
        && event.intent !== "implement"
      ) return prev
      return { ...prev, runIntent: event.intent }
    }
    case "infra_error": {
      // Stage 4 of plan 2026-05-18-ui-ux-polish-and-action-aware-spinner.md
      // (audit issue #1). Defensive: require a non-empty title so a
      // malformed emission can't produce a blank banner.
      if (typeof event.title !== "string" || event.title.length === 0) return prev
      return {
        ...prev,
        infraError: {
          title: event.title,
          message: typeof event.message === "string" ? event.message : "",
          hint: typeof event.hint === "string" && event.hint.length > 0 ? event.hint : null,
        },
      }
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
