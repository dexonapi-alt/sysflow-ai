import * as React from "react"
import { useEffect, useState } from "react"
import { Box, Text, useInput } from "ink"
import { palette, tempo } from "../theme.js"
import { matchSlashCommands, type SlashCommand } from "../state/slash-commands.js"
import { Breath, Fade } from "../animation/primitives/index.js"

interface Props {
  placeholder?: string
  disabled?: boolean
  onSubmit: (value: string) => void
  /** Recent prompts, oldest first. ↑/↓ navigates from the end backwards. */
  history?: string[]
}

/**
 * Phase 12 Stage 7: rotating placeholder hints. Shown only when the input
 * is empty so the user always has a tip to read but the surface isn't
 * shouting at them. New hint every ~6 seconds — slow enough that the eye
 * lands on it once, fast enough that an idle terminal feels inhabited.
 *
 * Exported so the rotation contract is testable without React.
 */
export const PLACEHOLDER_HINTS = [
  "type a prompt or / for commands…",
  "ask for a feature or paste a stack trace…",
  "describe what you want to build…",
  "/continue picks up the last task",
  "/help shows everything sys can do",
  "tab completes /slash commands",
] as const

/** Pure: pick a hint at the given rotation index. Wraps modulo the list
 *  length and returns the override `customPlaceholder` when supplied
 *  (back-compat: callers that pass a `placeholder` prop expect that
 *  string verbatim, not the rotation). */
export function pickHint(index: number, list: readonly string[] = PLACEHOLDER_HINTS, customPlaceholder?: string): string {
  if (customPlaceholder) return customPlaceholder
  if (list.length === 0) return ""
  const safe = Math.abs(Math.floor(index)) % list.length
  return list[safe]
}

/** Rotation cadence — long enough that the eye lands on a hint once before
 *  it's swapped out. Tied to the design's "breath, not blink" rule. */
const HINT_ROTATE_MS = 6_000

/**
 * Multi-line chat input.
 *
 * Conventions (terminals don't natively distinguish Shift+Enter from Enter,
 * so we follow the bash-heredoc tradition):
 *   - Plain Enter           submits the buffer
 *   - Backslash + Enter     inserts a newline (the `\` is consumed)
 *   - ↑ / ↓                 walk through `history` (only at first/last line)
 *   - Tab                   completes the current /slash command
 *   - Ctrl-C                exits sys
 *
 * Slash autocomplete: typing `/` shows a popup of matching commands beneath
 * the input. Tab picks the top match.
 */
export function ChatInput({ placeholder, disabled, onSubmit, history = [] }: Props): React.ReactElement {
  const [value, setValue] = useState("")
  const [historyIndex, setHistoryIndex] = useState<number | null>(null)
  const [draft, setDraft] = useState("")  // saved live buffer when scrolling history
  // Phase 12 Stage 7: rotate through PLACEHOLDER_HINTS every HINT_ROTATE_MS.
  // Stops cycling when the user's input is non-empty (we don't show the
  // placeholder anyway, so the timer would waste re-renders).
  const [hintIndex, setHintIndex] = useState(0)
  useEffect(() => {
    if (value.length > 0) return
    if (placeholder) return // caller supplied a fixed placeholder; no rotation
    const t = setInterval(() => setHintIndex((i) => i + 1), HINT_ROTATE_MS)
    return () => clearInterval(t)
  }, [value.length === 0, placeholder])

  // Reset history pointer whenever the live buffer is edited from scratch.
  useEffect(() => {
    if (historyIndex !== null && value !== history[historyIndex]) {
      setHistoryIndex(null)
    }
  }, [value, history, historyIndex])

  useInput((input, key) => {
    if (disabled) return

    if (key.ctrl && input === "c") {
      process.exit(0)
    }

    // ── Submit / multiline ──
    if (key.return) {
      // Backslash before Enter → newline (treat \-at-end as a continuation).
      if (value.endsWith("\\")) {
        setValue((v) => v.slice(0, -1) + "\n")
        return
      }
      const submission = value.trim()
      if (submission.length === 0) return
      setValue("")
      setHistoryIndex(null)
      setDraft("")
      onSubmit(submission)
      return
    }

    // ── History navigation ──
    if (key.upArrow) {
      if (history.length === 0) return
      if (historyIndex === null) {
        setDraft(value)
        const last = history.length - 1
        setHistoryIndex(last)
        setValue(history[last])
      } else if (historyIndex > 0) {
        setHistoryIndex(historyIndex - 1)
        setValue(history[historyIndex - 1])
      }
      return
    }
    if (key.downArrow) {
      if (historyIndex === null) return
      if (historyIndex < history.length - 1) {
        setHistoryIndex(historyIndex + 1)
        setValue(history[historyIndex + 1])
      } else {
        // Past the newest entry — restore the live draft.
        setHistoryIndex(null)
        setValue(draft)
      }
      return
    }

    // ── Slash autocomplete ──
    if (key.tab) {
      const matches = matchSlashCommands(value)
      if (matches.length > 0) {
        // Replace the partial token with the full command + a trailing space.
        const tail = value.includes(" ") ? value.slice(value.indexOf(" ")) : ""
        setValue(matches[0].command + (tail || " "))
      }
      return
    }

    // ── Editing ──
    if (key.backspace || key.delete) {
      setValue((v) => v.slice(0, -1))
      return
    }

    // Ignore other control sequences (escape, meta, arrows we didn't handle).
    if (key.meta || key.ctrl || key.escape || key.leftArrow || key.rightArrow || key.pageUp || key.pageDown) {
      return
    }

    if (input) {
      setValue((v) => v + input)
    }
  }, { isActive: !disabled })

  const showPlaceholder = value.length === 0
  const activeHint = pickHint(hintIndex, PLACEHOLDER_HINTS, placeholder)
  const lines = (showPlaceholder ? activeHint : value).split("\n")
  const matches = !showPlaceholder ? matchSlashCommands(value) : []

  return (
    <Box flexDirection="column">
      {lines.map((line, i) => (
        <Box key={i}>
          <Text color={palette.accent}>  {i === 0 ? ">" : "·"} </Text>
          {showPlaceholder
            ? (
              // Re-mount the Fade on each hintIndex change so the next
              // hint fades in fresh. The empty-list / custom-placeholder
              // paths skip the Fade — no animation when nothing rotates.
              placeholder
                ? <Text color={palette.muted}>{line}</Text>
                : <Fade key={hintIndex} direction="in" color={palette.muted} durationMs={400}>{line}</Fade>
            )
            : <Text>{line}</Text>}
          {!disabled && i === lines.length - 1 && (
            // Phase 12 Stage 7: cursor breathes at idleBpm so the input
            // always feels alive — even when the user hasn't typed yet.
            <Breath from={palette.accentDim} to={palette.accent} bpm={tempo.idleBpm}>▏</Breath>
          )}
        </Box>
      ))}
      {matches.length > 0 && (
        <SlashPopup matches={matches} />
      )}
      {!showPlaceholder && lines.length === 1 && history.length > 0 && historyIndex === null && (
        <Box>
          <Text color={palette.muted}>    ↑ history · Tab complete · \↵ newline</Text>
        </Box>
      )}
    </Box>
  )
}

function SlashPopup({ matches }: { matches: SlashCommand[] }): React.ReactElement {
  const visible = matches.slice(0, 6)
  return (
    <Box flexDirection="column" marginTop={0}>
      {visible.map((m, i) => (
        <Box key={m.command}>
          <Text color={palette.muted}>    </Text>
          <Text color={i === 0 ? palette.accent : palette.muted} bold={i === 0}>{m.command}</Text>
          {m.args && <Text color={palette.muted}> {m.args}</Text>}
          <Text color={palette.muted}>  — {m.description}</Text>
        </Box>
      ))}
      {matches.length > visible.length && (
        <Box>
          <Text color={palette.muted}>    … {matches.length - visible.length} more — keep typing to filter</Text>
        </Box>
      )}
    </Box>
  )
}
