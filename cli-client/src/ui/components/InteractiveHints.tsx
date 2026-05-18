/**
 * <InteractiveHints> — Phase 14 Stage 5: always-visible bottom row that
 * advertises the keys the user can press right now.
 *
 *   ↑ history  ·  / commands  ·  tab complete  ·  ctrl+c exit     (idle)
 *   ctrl+c cancel                                                  (working)
 *
 * The state is derived from the agent-events reducer — when a spinner
 * is in flight we're `working`; otherwise `idle`. The hint table itself
 * lives in `state/hints.ts` so adding a new state-aware affordance
 * (Phase 11 modal, ctrl+o expand, etc.) is a one-line table edit, not
 * a component refactor.
 *
 * This row replaces:
 *   - Header.tsx's second row of slash-command names (noisy + duplicated)
 *   - ChatInput.tsx's inline `↑ history · Tab complete · \↵ newline` line
 *
 * Mounted between ChatInput and LiveStatusBar in App.tsx so the eye
 * always knows where to look for "what can I press".
 *
 * Motion-disabled: nothing animates here — pure muted text.
 */

import * as React from "react"
import { Box, Text } from "ink"
import { palette } from "../theme.js"
import { useAgentEvents } from "../hooks/useAgentEvents.js"
import { pickHints, formatHints, type HintState } from "../state/hints.js"

/** Pure: derive the hint state from the reducer slots the row cares
 *  about. Exported so tests can assert the mapping without rendering Ink.
 *
 *  Stage 5 of plan 2026-05-18-ui-ux-polish-and-action-aware-spinner.md
 *  (audit issue #5): modal state wins over spinner state. When a
 *  raw-TTY modal has stdin control, idle keys (`↑ history`, `/ commands`)
 *  do nothing — the hint row showing them was actively misleading.
 *  Permission and off-course each get their own hint shape.
 */
export function deriveHintState(
  spinnerText: string | null,
  activeModal: "permission" | "offcourse" | null,
): HintState {
  if (activeModal === "permission") return "permission_modal"
  if (activeModal === "offcourse") return "offcourse_modal"
  return spinnerText !== null ? "working" : "idle"
}

export function InteractiveHints(): React.ReactElement | null {
  const { spinnerText, activeModal } = useAgentEvents()
  const state = deriveHintState(spinnerText, activeModal)
  const hints = pickHints(state)
  const text = formatHints(hints)
  if (text.length === 0) return null
  return (
    <Box>
      <Text color={palette.muted}>  {text}</Text>
    </Box>
  )
}
