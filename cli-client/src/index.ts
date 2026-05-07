import fs from "node:fs"
import { parseCliInput } from "./cli/parser.js"
import { ensureSysbase, setSelectedModel } from "./lib/sysbase.js"
import { runAgent } from "./agent/agent.js"
import { startUi } from "./cli/ui.js"
import { showModelPicker } from "./commands/model.js"
import { handleLogin, handleRegister, handleLogout, handleWhoami } from "./commands/auth.js"
import { showChats, deleteActiveChat } from "./commands/chats.js"
import { showPlanPicker, showUsage } from "./commands/billing.js"
import { applyEnv as applyMotionEnv } from "./ui/state/motion.js"

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

  // Phase 12 Stage 1: read --no-motion / SYS_NO_MOTION before anything else
  // initialises so the animation engine sees the correct setting from the
  // first hook call. Idempotent + best-effort — never throws.
  applyMotionEnv(args)

  // Phase 13: Ink mode is the default. Honour the explicit opt-out flags
  // (--legacy CLI flag, SYS_LEGACY=1, or SYS_INK=0 for symmetry with the
  // older opt-in path) by setting SYS_INK=0 so the rest of the codebase
  // sees the same answer through `isInkActive()`.
  if (args.includes("--legacy") || process.env.SYS_LEGACY === "1") {
    process.env.SYS_INK = "0"
  }

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

  // Phase 13: Ink mode is the default. Opt out with `--legacy`, `SYS_LEGACY=1`,
  // or `SYS_INK=0`. The interactive REPL mounts Ink; one-shot `sys "prompt"`
  // calls still take the runAgent direct path (no UI mounted).
  const inkEnabled = process.env.SYS_INK !== "0"

  // Support: echo "prompt" | sys  OR  cat prompt.txt | sys
  // Skipped when SYS_INK is on — Windows + the bin/sys.js spawn shim
  // sometimes misreports stdin as non-TTY in interactive PowerShell, which
  // would route us into readStdin() and then runAgent() before Ink mounts
  // (manifests as a "Could not establish a chat session" warning above the
  // status line). Ink mode owns its own input.
  if (!inkEnabled && !process.stdin.isTTY && args.length === 0) {
    const piped = await readStdin()
    if (piped) {
      await runAgent({ prompt: piped, command: null })
      return
    }
  }

  if (args.length === 0) {
    if (inkEnabled) {
      const { startInkUi } = await import("./ui/start.js")
      await startInkUi()
    } else {
      await startUi()
    }
    return
  }

  const parsed = parseCliInput(args)

  if (parsed.mode === "ui") {
    if (inkEnabled) {
      const { startInkUi } = await import("./ui/start.js")
      await startInkUi()
    } else {
      await startUi()
    }
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
