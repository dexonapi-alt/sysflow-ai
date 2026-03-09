import chalk from "chalk"
import readline from "node:readline"
import path from "node:path"
import { getAuthToken, saveActiveChat, getActiveChatInfo, clearActiveChat } from "../lib/sysbase.js"

const SERVER_URL = process.env.SYS_SERVER_URL || "http://localhost:3000"

async function apiGet(endpoint) {
  const token = await getAuthToken()
  if (!token) throw new Error("Not logged in. Run: sys login")

  const res = await fetch(`${SERVER_URL}${endpoint}`, {
    headers: { Authorization: `Bearer ${token}` }
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

async function apiPost(endpoint, body) {
  const token = await getAuthToken()
  if (!token) throw new Error("Not logged in. Run: sys login")

  const res = await fetch(`${SERVER_URL}${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

async function apiDelete(endpoint) {
  const token = await getAuthToken()
  if (!token) throw new Error("Not logged in. Run: sys login")

  const res = await fetch(`${SERVER_URL}${endpoint}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` }
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

function chatPicker(items, title, activeIndex) {
  return new Promise((resolve) => {
    let selected = activeIndex >= 0 ? activeIndex : 0
    const { stdin, stdout } = process

    // Count total lines rendered so we can erase precisely
    function buildLines() {
      const lines = []
      lines.push("")
      lines.push(chalk.white.bold(`  ${title}`))
      lines.push("")

      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        const pointer = i === selected ? chalk.cyan("▸ ") : "  "
        const label = i === selected ? chalk.white.bold(item.label) : chalk.dim(item.label)
        const tag = item.tag || ""
        lines.push(`  ${pointer}${label}${tag}`)
        if (item.desc) lines.push(chalk.dim(`    ${item.desc}`))
        if (item.summary) lines.push(chalk.dim(`    ${item.summary}`))
      }

      lines.push("")
      lines.push(chalk.dim("  ↑↓ navigate · enter select · d delete · q quit"))
      return lines
    }

    let prevLineCount = 0

    function render() {
      // Erase previous output
      if (prevLineCount > 0) {
        stdout.write(`\x1B[${prevLineCount}A\x1B[J`)
      }
      const lines = buildLines()
      prevLineCount = lines.length
      for (const line of lines) {
        stdout.write(line + "\n")
      }
    }

    if (stdin.isTTY) stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding("utf8")
    render()

    const onKey = (key) => {
      if (key === "\u0003" || key === "q") {
        if (stdin.isTTY) stdin.setRawMode(false)
        stdin.removeListener("data", onKey)
        stdin.pause()
        resolve(null)
        return
      }

      if (key === "\r" || key === "\n") {
        if (stdin.isTTY) stdin.setRawMode(false)
        stdin.removeListener("data", onKey)
        stdin.pause()
        resolve(items[selected])
        return
      }

      if (key === "d" || key === "D") {
        if (stdin.isTTY) stdin.setRawMode(false)
        stdin.removeListener("data", onKey)
        stdin.pause()
        resolve({ ...items[selected], _delete: true })
        return
      }

      if (key === "\u001B[A") {
        selected = (selected - 1 + items.length) % items.length
        render()
      }

      if (key === "\u001B[B") {
        selected = (selected + 1) % items.length
        render()
      }
    }

    stdin.on("data", onKey)
  })
}

export async function showChats() {
  const projectId = path.basename(process.cwd())

  try {
    const { chats } = await apiGet(`/chats?projectId=${encodeURIComponent(projectId)}`)
    const activeChat = await getActiveChatInfo()

    if (chats.length === 0 && !activeChat) {
      console.log("")
      console.log(chalk.yellow("  No chat sessions yet for this project"))
      console.log(chalk.dim("  A new chat will be created automatically when you run a command."))
      console.log("")
      return
    }

    // Build picker items
    const items = [
      { id: "__new__", label: "➕ New Chat", desc: "Start a fresh conversation", value: null }
    ]

    let activeIndex = 0 // default to "New Chat"

    for (let i = 0; i < chats.length; i++) {
      const chat = chats[i]
      const isActive = activeChat?.chatUid === chat.chat_uid
      const age = timeAgo(new Date(chat.updated_at))
      const sessions = parseInt(chat.session_count) || 0

      // Build summary line
      let summary = ""
      if (chat.last_prompt) {
        const prompt = chat.last_prompt.replace(/^\(interrupted\) actions: /, "").slice(0, 50)
        const outcomeIcon = chat.last_outcome === "completed" ? "✓" : chat.last_outcome === "failed" ? "✗" : "⚡"
        summary = `${outcomeIcon} "${prompt}"${prompt.length >= 50 ? "…" : ""}`
      }

      const tag = isActive ? chalk.green(" (active)") : ""

      items.push({
        id: chat.chat_uid,
        label: chat.title,
        tag,
        desc: `${age} · ${sessions} run${sessions !== 1 ? "s" : ""}`,
        summary: summary || null,
        value: chat
      })

      if (isActive) activeIndex = i + 1 // +1 because "New Chat" is index 0
    }

    const choice = await chatPicker(items, `Chat Sessions — ${projectId}`, activeIndex)

    if (!choice) {
      console.log(chalk.dim("  Cancelled"))
      console.log("")
      return
    }

    // Handle delete (d key in picker)
    if (choice._delete) {
      if (choice.id === "__new__") {
        console.log(chalk.dim("  Can't delete that"))
        console.log("")
        return
      }

      // Confirm before deleting
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
      const answer = await new Promise((resolve) => {
        rl.question(chalk.yellow(`  Delete "${choice.value.title}"? This cannot be undone. (y/N) `), (ans) => {
          rl.close()
          resolve(ans.trim().toLowerCase())
        })
      })

      if (answer !== "y" && answer !== "yes") {
        console.log(chalk.dim("  Cancelled"))
        console.log("")
        return
      }

      try {
        await apiDelete(`/chats/${choice.id}`)
        if (activeChat?.chatUid === choice.id) {
          await clearActiveChat()
        }
        console.log("")
        console.log(chalk.green(`  ✓ Deleted: ${choice.value.title}`))
        console.log("")
      } catch (delErr) {
        console.log(chalk.red(`  ${delErr.message}`))
        console.log("")
      }
      return
    }

    if (choice.id === "__new__") {
      const { chat } = await apiPost("/chats", {
        projectId,
        title: `Chat ${chats.length + 1}`
      })
      await saveActiveChat(chat.chat_uid, chat.title)
      console.log("")
      console.log(chalk.green(`  ✓ New chat: ${chat.title}`))
      console.log("")
    } else {
      await saveActiveChat(choice.value.chat_uid, choice.value.title)
      console.log("")
      console.log(chalk.green(`  ✓ Switched to: ${choice.value.title}`))
      console.log("")
    }
  } catch (err) {
    console.log(chalk.red(`  ${err.message}`))
    console.log("")
  }
}

/**
 * Show a picker to select which chat to delete, then confirm before deleting.
 */
export async function deleteActiveChat() {
  const projectId = path.basename(process.cwd())

  try {
    const { chats } = await apiGet(`/chats?projectId=${encodeURIComponent(projectId)}`)
    const activeChat = await getActiveChatInfo()

    if (!chats || chats.length === 0) {
      console.log("")
      console.log(chalk.yellow("  No chats to delete"))
      console.log("")
      return
    }

    // Build picker items (no "New Chat" option)
    const items = []
    let activeIndex = 0

    for (let i = 0; i < chats.length; i++) {
      const chat = chats[i]
      const isActive = activeChat?.chatUid === chat.chat_uid
      const age = timeAgo(new Date(chat.updated_at))
      const sessions = parseInt(chat.session_count) || 0
      const tag = isActive ? chalk.green(" (active)") : ""

      items.push({
        id: chat.chat_uid,
        label: chat.title,
        tag,
        desc: `${age} · ${sessions} run${sessions !== 1 ? "s" : ""}`,
        value: chat
      })

      if (isActive) activeIndex = i
    }

    const choice = await chatPicker(items, `Delete Chat — ${projectId}`, activeIndex)

    if (!choice) {
      console.log(chalk.dim("  Cancelled"))
      console.log("")
      return
    }

    // Confirm deletion
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    const answer = await new Promise((resolve) => {
      rl.question(chalk.yellow(`  Delete "${choice.value.title}"? This cannot be undone. (y/N) `), (ans) => {
        rl.close()
        resolve(ans.trim().toLowerCase())
      })
    })

    if (answer !== "y" && answer !== "yes") {
      console.log(chalk.dim("  Cancelled"))
      console.log("")
      return
    }

    await apiDelete(`/chats/${choice.id}`)

    // If we deleted the active chat, clear it
    if (activeChat?.chatUid === choice.id) {
      await clearActiveChat()
    }

    console.log("")
    console.log(chalk.green(`  ✓ Deleted: ${choice.value.title}`))
    console.log("")
  } catch (err) {
    console.log(chalk.red(`  ${err.message}`))
    console.log("")
  }
}

/**
 * Ensure there's an active chat for the current project.
 * 1. If we already have a saved active chat, use it.
 * 2. Otherwise, check the server for existing chats and pick the most recent.
 * 3. If no chats exist at all, create one.
 * Returns chatUid or null.
 */
export async function ensureActiveChat() {
  const token = await getAuthToken()
  if (!token) return null

  // 1. Check local saved chat
  const existing = await getActiveChatInfo()
  if (existing?.chatUid) return existing.chatUid

  const projectId = path.basename(process.cwd())

  try {
    // 2. Check server for existing chats in this project
    const { chats } = await apiGet(`/chats?projectId=${encodeURIComponent(projectId)}`)

    if (chats && chats.length > 0) {
      // Pick the most recent chat (already sorted by updated_at DESC)
      const latest = chats[0]
      await saveActiveChat(latest.chat_uid, latest.title)
      return latest.chat_uid
    }

    // 3. No chats exist — create one
    const { chat } = await apiPost("/chats", {
      projectId,
      title: "Chat 1"
    })
    await saveActiveChat(chat.chat_uid, chat.title)
    return chat.chat_uid
  } catch {
    return null
  }
}

function timeAgo(date) {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000)
  if (seconds < 60) return "just now"
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86400)}d ago`
}
