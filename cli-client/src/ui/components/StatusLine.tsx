import * as React from "react"
import { Box, Text } from "ink"
import path from "node:path"
import { palette } from "../theme.js"

interface Props {
  model: string
  user: string | null
  chatTitle: string | null
  planMode: boolean
  cwd?: string
}

/**
 * Top status bar rendered once at startup. Same data the legacy
 * `ui.ts` printed via console.log, but as a real component so we can
 * later swap pieces (e.g. add token usage) without coordinating prints.
 */
export function StatusLine({ model, user, chatTitle, planMode, cwd }: Props): React.ReactElement {
  const folder = path.basename(cwd ?? process.cwd())
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={palette.muted}>  sys v0.1  </Text>
        <Text>{folder}</Text>
        <Text color={palette.muted}>  model: </Text>
        <Text>{model}</Text>
        <Text color={palette.muted}>  user: </Text>
        <Text color={user ? palette.success : palette.warning}>{user ?? "not logged in"}</Text>
        <Text color={palette.muted}>  chat: </Text>
        <Text color={chatTitle ? palette.info : palette.muted}>{chatTitle ?? "no chat"}</Text>
        {planMode && (
          <>
            <Text>  </Text>
            <Text color={palette.warning}>plan-mode</Text>
          </>
        )}
      </Box>
      <Box>
        <Text color={palette.muted}>  /model /mode /permissions /plan-mode /memory /remember /chats /billing /usage /login /whoami /continue /exit</Text>
      </Box>
    </Box>
  )
}
