import fs from "node:fs"
import { parseCliInput } from "./cli/parser.js"
import { ensureSysbase, setSelectedModel } from "./lib/sysbase.js"
import { runAgent } from "./agent/agent.js"
import { startUi } from "./cli/ui.js"
import { showModelPicker } from "./commands/model.js"
import { handleLogin, handleRegister, handleLogout, handleWhoami } from "./commands/auth.js"
import { showChats, deleteActiveChat } from "./commands/chats.js"
import { showPlanPicker, showUsage } from "./commands/billing.js"

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = ""
    process.stdin.setEncoding("utf8")
    process.stdin.on("data", (chunk) => { data += chunk })
    process.stdin.on("end", () => resolve(data.trim()))
  })
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)

  // Support: sys -f prompt.txt
  const fileIdx = args.indexOf("-f")
  if (fileIdx !== -1 && args[fileIdx + 1]) {
    const filePath = args[fileIdx + 1]
    try {
      const content = fs.readFileSync(filePath, "utf8").trim()
      await runAgent({ prompt: content, command: null })
      return
    } catch (err) {
      console.error(`  error: Cannot read file ${filePath}: ${(err as Error).message}`)
      process.exit(1)
    }
  }

  // Support: echo "prompt" | sys  OR  cat prompt.txt | sys
  if (!process.stdin.isTTY && args.length === 0) {
    const piped = await readStdin()
    if (piped) {
      await runAgent({ prompt: piped, command: null })
      return
    }
  }

  if (args.length === 0) {
    await startUi()
    return
  }

  const parsed = parseCliInput(args)

  if (parsed.mode === "ui") {
    await startUi()
    return
  }

  if (parsed.mode === "login") { await handleLogin(); return }
  if (parsed.mode === "register") { await handleRegister(); return }
  if (parsed.mode === "logout") { await handleLogout(); return }
  if (parsed.mode === "whoami") { await handleWhoami(); return }
  if (parsed.mode === "chats") { await showChats(); return }
  if (parsed.mode === "delete-chat") { await deleteActiveChat(); return }
  if (parsed.mode === "billing") { await showPlanPicker(); return }
  if (parsed.mode === "usage") { await showUsage(); return }

  if (parsed.mode === "model") {
    await ensureSysbase()
    if (parsed.model) {
      await setSelectedModel(parsed.model)
      console.log(`  model set to ${parsed.model}`)
    } else {
      await showModelPicker()
    }
    return
  }

  if (parsed.mode === "noop") return

  await runAgent({
    prompt: parsed.prompt || "",
    command: parsed.command
  })
}

main().catch((error) => {
  console.error(`  error: ${(error as Error).message}`)
  process.exit(1)
})
