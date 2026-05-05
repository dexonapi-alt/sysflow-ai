import * as React from "react"
import { useEffect, useState } from "react"
import { Box, Text, useInput } from "ink"
import { palette } from "../theme.js"
import { matchSlashCommands, type SlashCommand } from "../state/slash-commands.js"

interface Props {
  placeholder?: string
  disabled?: boolean
  onSubmit: (value: string) => void
  /** Recent prompts, oldest first. ↑/↓ navigates from the end backwards. */
  history?: string[]
}

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
export function ChatInput({ placeholder = "type a prompt or / for commands…", disabled, onSubmit, history = [] }: Props): React.ReactElement {
  const [value, setValue] = useState("")
  const [historyIndex, setHistoryIndex] = useState<number | null>(null)
  const [draft, setDraft] = useState("")  // saved live buffer when scrolling history

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
  const lines = (showPlaceholder ? placeholder : value).split("\n")
  const matches = !showPlaceholder ? matchSlashCommands(value) : []

  return (
    <Box flexDirection="column">
      {lines.map((line, i) => (
        <Box key={i}>
          <Text color={palette.accent}>  {i === 0 ? ">" : "·"} </Text>
          {showPlaceholder
            ? <Text color={palette.muted}>{line}</Text>
            : <Text>{line}</Text>}
          {!disabled && i === lines.length - 1 && <Text color={palette.accent}>▏</Text>}
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
