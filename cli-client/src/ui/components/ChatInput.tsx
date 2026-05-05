import * as React from "react"
import { useState } from "react"
import { Box, Text, useInput } from "ink"
import { palette } from "../theme.js"

interface Props {
  placeholder?: string
  disabled?: boolean
  onSubmit: (value: string) => void
}

/**
 * Single-line input with placeholder + Enter to submit. Stage 1 keeps it
 * intentionally minimal — multiline (Shift+Enter), history, and slash-command
 * autocomplete come in Stage 2 of the Phase 9 plan.
 */
export function ChatInput({ placeholder = "type a prompt…", disabled, onSubmit }: Props): React.ReactElement {
  const [value, setValue] = useState("")

  useInput((input, key) => {
    if (disabled) return
    if (key.return) {
      const trimmed = value.trim()
      if (trimmed.length === 0) return
      setValue("")
      onSubmit(trimmed)
      return
    }
    if (key.backspace || key.delete) {
      setValue((v) => v.slice(0, -1))
      return
    }
    if (key.ctrl && input === "c") {
      process.exit(0)
    }
    // Ignore other control keys (arrows, tab, escape) for now — handled in
    // later stages alongside history + slash autocomplete.
    if (key.meta || key.ctrl || key.tab || key.upArrow || key.downArrow || key.leftArrow || key.rightArrow || key.escape) {
      return
    }
    if (input) {
      setValue((v) => v + input)
    }
  }, { isActive: !disabled })

  const display = value.length > 0 ? value : placeholder
  const showPlaceholder = value.length === 0

  return (
    <Box>
      <Text color={palette.accent}>  {">"} </Text>
      {showPlaceholder
        ? <Text color={palette.muted}>{display}</Text>
        : <Text>{display}</Text>}
      {!disabled && <Text color={palette.accent}>▏</Text>}
    </Box>
  )
}
