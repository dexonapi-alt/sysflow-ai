import path from "node:path"
import readline from "node:readline"
import chalk from "chalk"
import { ensureSysbase, getSelectedModel, setSelectedModel, getAuthUser, getActiveChatInfo } from "../lib/sysbase.js"
import { runAgent } from "../agent/agent.js"
import { parseUiLine } from "./parser.js"

const PROMPT = chalk.blue("  | ")

export async function startUi(): Promise<void> {
  await ensureSysbase()
  const currentModel = await getSelectedModel()
  const user = await getAuthUser()
  const chatInfo = await getActiveChatInfo()

  console.log("")
  const userTag = user ? chalk.green(String(user.username)) : chalk.yellow("not logged in")
  const chatTag = chatInfo?.title ? chalk.cyan(String(chatInfo.title)) : chalk.dim("no chat")
  console.log(chalk.dim(`  sys v0.1  ${chalk.white(path.basename(process.cwd()))}  model: ${chalk.white(currentModel)}  user: ${userTag}  chat: ${chatTag}`))
  console.log(chalk.dim("  /model /chats /billing /usage /login /whoami /continue /exit"))
  console.log("")

  let working = false

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: PROMPT
  })

  rl.prompt()

  // ─── Robust multi-line paste handling ───
  //
  // Problem: readline fires "line" per newline. When pasting multi-line text,
  // only the first line gets processed and the rest is dropped (working=true).
  //
  // Solution: Two-layer paste detection:
  //
  // 1. Bracket paste mode (modern terminals): stdin sends \x1b[200~ before paste
  //    and \x1b[201~ after. We detect these to know exactly when a paste starts/ends.
  //
  // 2. Fallback debounce: Buffer all lines and wait 150ms of silence before processing.
  //    150ms is long enough to catch even slow terminal paste delivery, but short enough
  //    that a human pressing Enter won't notice the delay.

  let lineBuffer: string[] = []
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  let isPasting = false

  // Enable bracket paste mode — tells the terminal to wrap pastes in escape sequences
  if (process.stdin.isTTY) {
    process.stdout.write("\x1b[?2004h")
  }

  // Listen on raw stdin data for bracket paste escape sequences
  // This fires BEFORE readline processes the data into "line" events
  process.stdin.on("data", (chunk: Buffer) => {
    const str = chunk.toString()
    if (str.includes("\x1b[200~")) {
      isPasting = true
      // Clear any pending debounce — we'll wait for paste end instead
      if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null }
    }
    if (str.includes("\x1b[201~")) {
      isPasting = false
      // Paste ended — flush after a tiny delay to let final "line" events arrive
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(flushLineBuffer, 30)
    }
  })

  const PASTE_DEBOUNCE_MS = 150  // fallback for terminals without bracket paste

  function flushLineBuffer(): void {
    debounceTimer = null
    const fullInput = lineBuffer.join("\n").trim()
    lineBuffer = []
    if (!fullInput) {
      rl.prompt()
      return
    }
    processInput(fullInput)
  }

  rl.on("line", (line) => {
    if (working) return

    lineBuffer.push(line)

    if (isPasting) {
      // Inside a bracket paste — don't flush yet, wait for paste end
      return
    }

    // Debounce: wait for more lines (handles terminals without bracket paste)
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(flushLineBuffer, PASTE_DEBOUNCE_MS)
  })

  async function processInput(fullInput: string): Promise<void> {
    const parsed = parseUiLine(fullInput)

    if (!parsed) {
      rl.prompt()
      return
    }

    if (parsed.mode === "exit") {
      // Disable bracket paste mode before exiting
      if (process.stdin.isTTY) process.stdout.write("\x1b[?2004l")
      console.log(chalk.dim("  bye"))
      rl.close()
      return
    }

    if (parsed.mode === "login") {
      const { handleLogin } = await import("../commands/auth.js")
      await handleLogin()
      rl.prompt()
      return
    }

    if (parsed.mode === "register") {
      const { handleRegister } = await import("../commands/auth.js")
      await handleRegister()
      rl.prompt()
      return
    }

    if (parsed.mode === "logout") {
      const { handleLogout } = await import("../commands/auth.js")
      await handleLogout()
      rl.prompt()
      return
    }

    if (parsed.mode === "whoami") {
      const { handleWhoami } = await import("../commands/auth.js")
      await handleWhoami()
      rl.prompt()
      return
    }

    if (parsed.mode === "chats") {
      const { showChats } = await import("../commands/chats.js")
      await showChats()
      rl.prompt()
      return
    }

    if (parsed.mode === "delete-chat") {
      const { deleteActiveChat } = await import("../commands/chats.js")
      await deleteActiveChat()
      rl.prompt()
      return
    }

    if (parsed.mode === "billing") {
      const { showPlanPicker } = await import("../commands/billing.js")
      await showPlanPicker()
      rl.prompt()
      return
    }

    if (parsed.mode === "usage") {
      const { showUsage } = await import("../commands/billing.js")
      await showUsage()
      rl.prompt()
      return
    }

    if (parsed.mode === "model") {
      if (parsed.model) {
        await setSelectedModel(parsed.model)
        console.log(chalk.green(`  model set to ${parsed.model}`))
      } else {
        const { showModelPicker } = await import("../commands/model.js")
        await showModelPicker()
      }
      console.log("")
      rl.prompt()
      return
    }

    working = true
    rl.pause()
    process.stdout.write("\r\x1B[K")

    try {
      await runAgent({
        prompt: parsed.prompt || "",
        command: parsed.command
      })
    } catch (error) {
      console.log(chalk.red(`  error: ${(error as Error).message}`))
    }

    working = false
    console.log("")
    rl.resume()
    rl.prompt()
  }

  rl.on("close", () => {
    // Disable bracket paste mode on exit
    if (process.stdin.isTTY) process.stdout.write("\x1b[?2004l")
    process.exit(0)
  })
}
