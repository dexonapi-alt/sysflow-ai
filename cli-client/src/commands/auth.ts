import readline from "node:readline"
import chalk from "chalk"
import { saveAuthToken, getAuthToken, getAuthUser, clearAuth } from "../lib/sysbase.js"

const SERVER_URL = process.env.SYS_SERVER_URL || "http://localhost:4000"

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(question)
    const rl = readline.createInterface({ input: process.stdin, terminal: false })
    if (process.stdin.isTTY) process.stdin.setRawMode(true)

    let password = ""
    const onData = (ch: Buffer) => {
      const c = ch.toString()
      if (c === "\n" || c === "\r") {
        if (process.stdin.isTTY) process.stdin.setRawMode(false)
        process.stdin.removeListener("data", onData)
        process.stdout.write("\n")
        rl.close()
        resolve(password)
      } else if (c === "\u007F" || c === "\b") {
        if (password.length > 0) {
          password = password.slice(0, -1)
          process.stdout.write("\b \b")
        }
      } else if (c === "\u0003") {
        process.exit(0)
      } else {
        password += c
        process.stdout.write("*")
      }
    }

    process.stdin.resume()
    process.stdin.on("data", onData)
  })
}

const BOX_W = 48
const BORDER_COLOR = chalk.cyan
const ACCENT = chalk.cyan.bold

function boxTop(title: string): string {
  const inner = BOX_W - 2
  const pad = Math.max(0, inner - title.length - 2)
  const left = Math.floor(pad / 2)
  const right = pad - left
  return BORDER_COLOR("  ╭" + "─".repeat(left) + ` ${title} ` + "─".repeat(right) + "╮")
}

function boxRow(text: string, raw?: string): string {
  const inner = BOX_W - 2
  const visLen = raw ? raw.length : text.replace(/\x1B\[[0-9;]*m/g, "").length
  const padR = Math.max(0, inner - visLen)
  return BORDER_COLOR("  │") + text + " ".repeat(padR) + BORDER_COLOR("│")
}

function boxEmpty(): string {
  return boxRow("", "")
}

function boxBottom(): string {
  return BORDER_COLOR("  ╰" + "─".repeat(BOX_W - 2) + "╯")
}

function boxDivider(): string {
  return BORDER_COLOR("  ├" + "─".repeat(BOX_W - 2) + "┤")
}

export async function showAuthPopup(initialTab: string = "login"): Promise<Record<string, unknown> | null> {
  let tab = initialTab
  let result: Record<string, unknown> | null = null

  while (!result) {
    const loginTab = tab === "login"
      ? chalk.bgCyan.black.bold(" LOGIN ")
      : chalk.dim(" LOGIN ")
    const registerTab = tab === "register"
      ? chalk.bgCyan.black.bold(" REGISTER ")
      : chalk.dim(" REGISTER ")

    console.log("")
    console.log(boxTop("Sysflow Auth"))
    console.log(boxEmpty())
    console.log(boxRow(`  ${loginTab}  ${registerTab}`, `   LOGIN    REGISTER `))
    console.log(boxEmpty())
    console.log(boxDivider())
    console.log(boxEmpty())

    if (tab === "login") {
      console.log(boxRow(chalk.dim("  Log in to your account"), "  Log in to your account"))
    } else {
      console.log(boxRow(chalk.dim("  Create a new account"), "  Create a new account"))
    }

    console.log(boxEmpty())
    console.log(boxBottom())
    console.log("")
    console.log(chalk.dim("  Press Enter with empty username to switch tab  ·  Ctrl+C to cancel"))
    console.log("")

    const username = await prompt(ACCENT("  Username: "))
    if (!username) {
      tab = tab === "login" ? "register" : "login"
      process.stdout.write(`\x1B[14A\x1B[J`)
      continue
    }

    if (tab === "register" && username.length < 3) {
      console.log(chalk.red("  ✗ Username must be at least 3 characters"))
      await sleep(1500)
      process.stdout.write(`\x1B[16A\x1B[J`)
      continue
    }

    const password = await promptHidden(ACCENT("  Password: "))
    if (!password) {
      tab = tab === "login" ? "register" : "login"
      process.stdout.write(`\x1B[16A\x1B[J`)
      continue
    }

    if (tab === "register" && password.length < 4) {
      console.log(chalk.red("  ✗ Password must be at least 4 characters"))
      await sleep(1500)
      process.stdout.write(`\x1B[17A\x1B[J`)
      continue
    }

    const endpoint = tab === "login" ? "/auth/login" : "/auth/register"
    try {
      const res = await fetch(`${SERVER_URL}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password })
      })

      const data = await res.json() as Record<string, unknown>

      if (!res.ok) {
        console.log("")
        console.log(chalk.red(`  ✗ ${data.error || "Failed"}`))

        if (tab === "login" && ((data.error as string) || "").includes("Invalid")) {
          console.log(chalk.dim("  Press enter with empty username to switch to Register"))
        }

        console.log("")
        await sleep(2000)
        process.stdout.write(`\x1B[19A\x1B[J`)
        continue
      }

      await saveAuthToken(data.token as string, data.user as Record<string, unknown>)
      result = data
    } catch (err) {
      console.log("")
      console.log(chalk.red(`  ✗ Connection error: ${(err as Error).message}`))
      console.log(chalk.dim("  Is the server running?"))
      console.log("")
      return null
    }
  }

  const user = result.user as Record<string, unknown>
  console.log("")
  console.log(boxTop("Welcome"))
  console.log(boxEmpty())
  console.log(boxRow(`  ${chalk.green("✓")} Logged in as ${chalk.white.bold(String(user.username))}`, `  ✓ Logged in as ${user.username}`))
  console.log(boxEmpty())
  console.log(boxRow(chalk.dim("  Token saved. You're ready to go!"), "  Token saved. You're ready to go!"))
  console.log(boxEmpty())
  console.log(boxBottom())
  console.log("")

  return result
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export async function handleRegister(): Promise<Record<string, unknown> | null> {
  return showAuthPopup("register")
}

export async function handleLogin(): Promise<Record<string, unknown> | null> {
  return showAuthPopup("login")
}

export async function handleLogout(): Promise<void> {
  await clearAuth()
  console.log("")
  console.log(chalk.green("  ✓ Logged out"))
  console.log("")
}

export async function handleWhoami(): Promise<void> {
  const user = await getAuthUser()
  const token = await getAuthToken()

  console.log("")
  if (!user || !token) {
    console.log(chalk.yellow("  Not logged in"))
    console.log(chalk.dim("  Run: sys register or sys login"))
  } else {
    console.log(chalk.green(`  ✓ Logged in as ${user.username}`))
    console.log(chalk.dim(`  User ID: ${user.id}`))

    try {
      const res = await fetch(`${SERVER_URL}/billing/usage`, {
        headers: { Authorization: `Bearer ${token}` }
      })
      if (res.ok) {
        const data = await res.json() as Record<string, unknown>
        console.log("")
        console.log(chalk.dim(`  Plan: ${chalk.white(String(data.planLabel || data.plan))}`))
        if (data.plan === "free") {
          console.log(chalk.dim(`  Prompts today: ${data.promptsUsed}/${data.promptsLimit}`))
        } else {
          console.log(chalk.dim(`  Credits: $${data.creditsRemaining} / $${data.creditsTotal}`))
        }
      }
    } catch {
      // server offline, skip usage display
    }
  }
  console.log("")
}
