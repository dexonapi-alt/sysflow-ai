import readline from "node:readline"
import chalk from "chalk"
import { getAuthToken } from "../lib/sysbase.js"

const SERVER_URL = process.env.SYS_SERVER_URL || "http://localhost:3000"

// ─── Box drawing helpers ───

const BOX_W = 56
const B = chalk.magenta

function boxTop(title) {
  const inner = BOX_W - 2
  const pad = Math.max(0, inner - title.length - 2)
  const left = Math.floor(pad / 2)
  const right = pad - left
  return B("  ╭" + "─".repeat(left) + ` ${title} ` + "─".repeat(right) + "╮")
}

function boxRow(text, rawLen) {
  const inner = BOX_W - 2
  const visLen = rawLen != null ? rawLen : text.replace(/\x1B\[[0-9;]*m/g, "").length
  const padR = Math.max(0, inner - visLen)
  return B("  │") + text + " ".repeat(padR) + B("│")
}

function boxEmpty() {
  return boxRow("", 0)
}

function boxBottom() {
  return B("  ╰" + "─".repeat(BOX_W - 2) + "╯")
}

function boxDivider() {
  return B("  ├" + "─".repeat(BOX_W - 2) + "┤")
}

// ─── Plan picker popup ───

export async function showPlanPicker() {
  const token = await getAuthToken()
  if (!token) {
    console.log("")
    console.log(chalk.yellow("  Not logged in. Run: sys login"))
    console.log("")
    return
  }

  // Fetch plans and current usage
  let plans, usage
  try {
    const [plansRes, usageRes] = await Promise.all([
      fetch(`${SERVER_URL}/billing/plans`),
      fetch(`${SERVER_URL}/billing/usage`, {
        headers: { Authorization: `Bearer ${token}` }
      })
    ])
    plans = (await plansRes.json()).plans
    usage = await usageRes.json()
  } catch (err) {
    console.log(chalk.red(`  Connection error: ${err.message}`))
    return
  }

  const currentPlan = usage.plan || "free"

  // Build display items
  const items = plans.map((p) => {
    const isCurrent = p.id === currentPlan
    return {
      id: p.id,
      label: p.label,
      price: p.price,
      desc: p.desc,
      priceId: p.priceId,
      isCurrent
    }
  })

  let selected = items.findIndex((i) => i.isCurrent)
  if (selected < 0) selected = 0

  let prevLineCount = 0

  function render() {
    // Erase previous output by moving up and clearing
    if (prevLineCount > 0) {
      process.stdout.write(`\x1B[${prevLineCount}A\x1B[J`)
    }

    const lines = []
    lines.push("")
    lines.push(boxTop("Subscription Plans"))
    lines.push(boxEmpty())

    // Current status
    if (currentPlan === "free") {
      const statusText = `  Plan: Free  ·  ${usage.promptsUsed || 0}/${usage.promptsLimit || 10} prompts today`
      lines.push(boxRow(chalk.dim(statusText), statusText.length))
    } else {
      const statusText = `  Plan: ${usage.planLabel}  ·  $${usage.creditsRemaining}/$${usage.creditsTotal} credits`
      lines.push(boxRow(chalk.dim(statusText), statusText.length))
    }

    lines.push(boxEmpty())
    lines.push(boxDivider())
    lines.push(boxEmpty())

    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      const pointer = i === selected ? chalk.magenta.bold(" ▸ ") : "   "
      const tag = item.isCurrent ? chalk.green(" (current)") : ""
      const labelText = i === selected
        ? chalk.white.bold(`${item.label}`) + chalk.dim(` ${item.price}`) + tag
        : chalk.dim(`${item.label} ${item.price}`) + tag

      const rawLabel = ` ${item.label} ${item.price}` + (item.isCurrent ? " (current)" : "")
      lines.push(boxRow(`${pointer}${labelText}`, rawLabel.length + 3))

      const descRaw = `     ${item.desc}`
      lines.push(boxRow(chalk.dim(`     ${item.desc}`), descRaw.length))

      if (i < items.length - 1) lines.push(boxEmpty())
    }

    lines.push(boxEmpty())
    lines.push(boxBottom())
    lines.push("")
    lines.push(chalk.dim("  ↑↓ navigate  ·  Enter select  ·  Esc cancel"))

    prevLineCount = lines.length
    for (const line of lines) {
      process.stdout.write(line + "\n")
    }
  }

  render()

  const choice = await new Promise((resolve) => {
    const { stdin } = process
    if (stdin.isTTY) stdin.setRawMode(true)
    readline.emitKeypressEvents(stdin)
    stdin.resume()

    const onKey = (str, key) => {
      if (!key) return
      if (key.name === "up") {
        selected = (selected - 1 + items.length) % items.length
        render()
      } else if (key.name === "down") {
        selected = (selected + 1) % items.length
        render()
      } else if (key.name === "return") {
        stdin.removeListener("keypress", onKey)
        if (stdin.isTTY) stdin.setRawMode(false)
        stdin.pause()
        resolve(items[selected])
      } else if (key.name === "escape" || (key.ctrl && key.name === "c")) {
        stdin.removeListener("keypress", onKey)
        if (stdin.isTTY) stdin.setRawMode(false)
        stdin.pause()
        resolve(null)
      }
    }

    stdin.on("keypress", onKey)
  })

  if (!choice) {
    console.log(chalk.dim("  Cancelled"))
    console.log("")
    return
  }

  if (choice.isCurrent) {
    console.log("")
    console.log(chalk.dim(`  Already on ${choice.label} plan`))
    console.log("")
    return
  }

  if (choice.id === "free") {
    console.log("")
    console.log(chalk.dim("  You're already on the Free plan (or downgrade via Stripe portal)"))
    console.log("")
    return
  }

  // Create checkout session
  console.log("")
  console.log(chalk.dim("  Creating checkout session..."))

  try {
    const res = await fetch(`${SERVER_URL}/billing/checkout`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ priceId: choice.priceId })
    })

    const data = await res.json()

    if (!res.ok) {
      console.log(chalk.red(`  ${data.error || "Checkout failed"}`))
      return
    }

    console.log("")
    console.log(chalk.dim("  Open this URL to pay:"))
    console.log("")
    console.log(chalk.cyan.underline(`  ${data.url}`))
    console.log("")

    // Try to open the URL automatically
    try {
      const { exec } = await import("node:child_process")
      const platform = process.platform
      const cmd = platform === "win32" ? "start" : platform === "darwin" ? "open" : "xdg-open"
      exec(`${cmd} "${data.url}"`)
      console.log(chalk.dim("  (Opened in browser)"))
    } catch {
      // couldn't auto-open, that's fine
    }

    console.log("")
    console.log(chalk.dim("  Waiting for payment..."))

    // Wait for payment via SSE — server pushes when success page is hit
    const sseUrl = `${SERVER_URL}/billing/checkout-stream?sessionId=${encodeURIComponent(data.sessionId)}`
    const result = await new Promise((resolve) => {
      const controller = new AbortController()
      const timeout = setTimeout(() => {
        controller.abort()
        resolve(null)
      }, 5 * 60 * 1000) // 5 min safety timeout

      fetch(sseUrl, { signal: controller.signal })
        .then(async (res) => {
          const reader = res.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ""

          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })

            // Parse SSE data lines
            const lines = buffer.split("\n")
            buffer = lines.pop() || ""
            for (const line of lines) {
              if (line.startsWith("data: ")) {
                try {
                  const parsed = JSON.parse(line.slice(6))
                  if (parsed.status === "paid") {
                    clearTimeout(timeout)
                    resolve(parsed)
                    return
                  }
                } catch {}
              }
            }
          }
        })
        .catch(() => {
          clearTimeout(timeout)
          resolve(null)
        })
    })

    if (result?.status === "paid") {
      console.log(chalk.green(`  ✓ ${choice.label} plan activated! (${choice.price})`))
    } else {
      console.log(chalk.yellow("  Connection lost. Run sys billing to check your plan status."))
    }
    console.log("")
  } catch (err) {
    console.log(chalk.red(`  Connection error: ${err.message}`))
  }
}

// ─── Show usage summary ───

export async function showUsage() {
  const token = await getAuthToken()
  if (!token) {
    console.log("")
    console.log(chalk.yellow("  Not logged in. Run: sys login"))
    console.log("")
    return
  }

  try {
    const res = await fetch(`${SERVER_URL}/billing/usage`, {
      headers: { Authorization: `Bearer ${token}` }
    })

    if (!res.ok) {
      console.log(chalk.red("  Failed to fetch usage"))
      return
    }

    const data = await res.json()

    console.log("")
    console.log(boxTop("Usage"))
    console.log(boxEmpty())

    const planRow = `  Plan: ${data.planLabel || data.plan}`
    console.log(boxRow(chalk.white.bold(planRow), planRow.length))
    console.log(boxEmpty())

    if (data.plan === "free") {
      const usedRow = `  Prompts today: ${data.promptsUsed} / ${data.promptsLimit}`
      const remainRow = `  Remaining: ${data.promptsRemaining}`
      console.log(boxRow(chalk.dim(usedRow), usedRow.length))
      console.log(boxRow(chalk.dim(remainRow), remainRow.length))
    } else {
      const credRow = `  Credits: $${data.creditsRemaining} / $${data.creditsTotal}`
      const costRow = `  Today's cost: $${(data.todayCostCents / 100).toFixed(4)}`
      const reqRow = `  Today's requests: ${data.todayRequests}`
      console.log(boxRow(chalk.dim(credRow), credRow.length))
      console.log(boxRow(chalk.dim(costRow), costRow.length))
      console.log(boxRow(chalk.dim(reqRow), reqRow.length))
      if (data.periodEnd) {
        const renewDate = new Date(data.periodEnd).toLocaleDateString()
        const renewRow = `  Renews: ${renewDate}`
        console.log(boxRow(chalk.dim(renewRow), renewRow.length))
      }
    }

    console.log(boxEmpty())
    console.log(boxBottom())
    console.log("")
  } catch (err) {
    console.log(chalk.red(`  Connection error: ${err.message}`))
  }
}
