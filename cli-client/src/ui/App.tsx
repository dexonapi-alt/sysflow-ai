import * as React from "react"
import { useEffect, useState } from "react"
import { Box, Text } from "ink"
import { StatusLine } from "./components/StatusLine.js"
import { ChatInput } from "./components/ChatInput.js"
import { Spinner } from "./components/Spinner.js"
import { palette } from "./theme.js"
import { ensureSysbase, getSelectedModel, getAuthUser, getActiveChatInfo, getPlanMode, getSysbasePath } from "../lib/sysbase.js"
import { runAgent } from "../agent/agent.js"
import { loadHistory, appendHistory } from "./state/history.js"

interface Status {
  model: string
  user: string | null
  chatTitle: string | null
  planMode: boolean
}

/**
 * Root component for the Ink UI. Stage 1: renders the status line + chat
 * input + active spinner. Submitting a prompt still hands off to the
 * existing `runAgent` (which keeps its console.log rendering until Stage 3
 * migrates it). The point of this stage is to prove the wiring works
 * behind the SYS_INK flag.
 */
export function App(): React.ReactElement {
  const [status, setStatus] = useState<Status | null>(null)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [history, setHistory] = useState<string[]>([])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      await ensureSysbase()
      const [model, user, chatInfo, planMode, hist] = await Promise.all([
        getSelectedModel(),
        getAuthUser(),
        getActiveChatInfo(),
        getPlanMode(),
        loadHistory(getSysbasePath()),
      ])
      if (cancelled) return
      setStatus({
        model,
        user: user ? String(user.username) : null,
        chatTitle: chatInfo?.title ? String(chatInfo.title) : null,
        planMode: Boolean(planMode),
      })
      setHistory(hist)
    })()
    return () => { cancelled = true }
  }, [])

  const handleSubmit = async (prompt: string): Promise<void> => {
    setError(null)
    setWorking(true)
    setHistory((h) => [...h.filter((p) => p !== prompt), prompt].slice(-100))
    void appendHistory(getSysbasePath(), prompt)
    try {
      await runAgent({ prompt, command: null })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setWorking(false)
    }
  }

  if (!status) {
    return (
      <Box paddingY={1}>
        <Spinner text="loading…" />
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Box marginTop={1}>
        <StatusLine
          model={status.model}
          user={status.user}
          chatTitle={status.chatTitle}
          planMode={status.planMode}
        />
      </Box>
      <Box marginTop={1}>
        {working
          ? <Spinner />
          : <ChatInput onSubmit={handleSubmit} history={history} />}
      </Box>
      {error && (
        <Box marginTop={1}>
          <Text color={palette.error}>  ✖ {error}</Text>
        </Box>
      )}
    </Box>
  )
}
