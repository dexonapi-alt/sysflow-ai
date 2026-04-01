import chalk from "chalk"
import readline from "node:readline"
import path from "node:path"
import { getAuthToken, saveActiveChat, getActiveChatInfo, clearActiveChat } from "../lib/sysbase.js"

const SERVER_URL = process.env.SYS_SERVER_URL || "http://localhost:4000"

async function apiGet(endpoint: string): Promise<Record<string, unknown>> {
  const token = await getAuthToken()
  if (!token) throw new Error("Not logged in. Run: sys login")

  const res = await fetch(`${SERVER_URL}${endpoint}`, {
    headers: { Authorization: `Bearer ${token}` }
  })
  const data = await res.json() as Record<string, unknown>
  if (!res.ok) throw new Error((data.error as string) || `HTTP ${res.status}`)
  return data
}

async function apiPost(endpoint: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
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
  const data = await res.json() as Record<string, unknown>
  if (!res.ok) throw new Error((data.error as string) || `HTTP ${res.status}`)
  return data
}

async function apiDelete(endpoint: string): Promise<Record<string, unknown>> {
  const token = await getAuthToken()
  if (!token) throw new Error("Not logged in. Run: sys login")

  const res = await fetch(`${SERVER_URL}${endpoint}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` }
  })
  const data = await res.json() as Record<string, unknown>
  if (!res.ok) throw new Error((data.error as string) || `HTTP ${res.status}`)
  return data
}

interface PickerItem {
  id: string
  label: string
  tag?: string
  desc?: string
  summary?: string | null
  value: Record<string, unknown> | null
  _delete?: boolean
}

function chatPicker(items: PickerItem[], title: string, activeIndex: number): Promise<PickerItem | null> {
  return new Promise((resolve) => {
    let selected = activeIndex >= 0 ? activeIndex : 0
    const { stdin, stdout } = process

    function buildLines(): string[] {
      const lines: string[] = []
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

    function render(): void {
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

    const onKey = (key: string) => {
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

export async function showChats(): Promise<void> {
  const projectId = path.basename(process.cwd())

  try {
    const { chats } = await apiGet(`/chats?projectId=${encodeURIComponent(projectId)}`) as { chats: Array<Record<string, unknown>> }
    const activeChat = await getActiveChatInfo()

    if ((chats as unknown[]).length === 0 && !activeChat) {
      console.log("")
      console.log(chalk.yellow("  No chat sessions yet for this project"))
      console.log(chalk.dim("  A new chat will be created automatically when you run a command."))
      console.log("")
      return
    }

    const items: PickerItem[] = [
      { id: "__new__", label: "➕ New Chat", desc: "Start a fresh conversation", value: null }
    ]

    let activeIndex = 0

    for (let i = 0; i < chats.length; i++) {
      const chat = chats[i]
      const isActive = activeChat?.chatUid === chat.chat_uid
      const age = timeAgo(new Date(chat.updated_at as string))
      const sessions = parseInt(String(chat.session_count)) || 0

      let summary = ""
      if (chat.last_prompt) {
        const prompt = (chat.last_prompt as string).replace(/^\(interrupted\) actions: /, "").slice(0, 50)
        const outcomeIcon = chat.last_outcome === "completed" ? "✓" : chat.last_outcome === "failed" ? "✗" : "⚡"
        summary = `${outcomeIcon} "${prompt}"${prompt.length >= 50 ? "…" : ""}`
      }

      const tag = isActive ? chalk.green(" (active)") : ""

      items.push({
        id: chat.chat_uid as string,
        label: chat.title as string,
        tag,
        desc: `${age} · ${sessions} run${sessions !== 1 ? "s" : ""}`,
        summary: summary || null,
        value: chat
      })

      if (isActive) activeIndex = i + 1
    }

    const choice = await chatPicker(items, `Chat Sessions — ${projectId}`, activeIndex)

    if (!choice) {
      console.log(chalk.dim("  Cancelled"))
      console.log("")
      return
    }

    if (choice._delete) {
      if (choice.id === "__new__") {
        console.log(chalk.dim("  Can't delete that"))
        console.log("")
        return
      }

      const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
      const answer = await new Promise<string>((resolve) => {
        rl.question(chalk.yellow(`  Delete "${(choice.value as Record<string, unknown>).title}"? This cannot be undone. (y/N) `), (ans) => {
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
        console.log(chalk.green(`  ✓ Deleted: ${(choice.value as Record<string, unknown>).title}`))
        console.log("")
      } catch (delErr) {
        console.log(chalk.red(`  ${(delErr as Error).message}`))
        console.log("")
      }
      return
    }

    if (choice.id === "__new__") {
      const { chat } = await apiPost("/chats", {
        projectId,
        title: `Chat ${chats.length + 1}`
      }) as { chat: Record<string, unknown> }
      await saveActiveChat(chat.chat_uid as string, chat.title as string)
      console.log("")
      console.log(chalk.green(`  ✓ New chat: ${chat.title}`))
      console.log("")
    } else {
      const val = choice.value as Record<string, unknown>
      await saveActiveChat(val.chat_uid as string, val.title as string)
      console.log("")
      console.log(chalk.green(`  ✓ Switched to: ${val.title}`))
      console.log("")
    }
  } catch (err) {
    console.log(chalk.red(`  ${(err as Error).message}`))
    console.log("")
  }
}

export async function deleteActiveChat(): Promise<void> {
  const projectId = path.basename(process.cwd())

  try {
    const { chats } = await apiGet(`/chats?projectId=${encodeURIComponent(projectId)}`) as { chats: Array<Record<string, unknown>> }
    const activeChat = await getActiveChatInfo()

    if (!chats || chats.length === 0) {
      console.log("")
      console.log(chalk.yellow("  No chats to delete"))
      console.log("")
      return
    }

    const items: PickerItem[] = []
    let activeIndex = 0

    for (let i = 0; i < chats.length; i++) {
      const chat = chats[i]
      const isActive = activeChat?.chatUid === chat.chat_uid
      const age = timeAgo(new Date(chat.updated_at as string))
      const sessions = parseInt(String(chat.session_count)) || 0
      const tag = isActive ? chalk.green(" (active)") : ""

      items.push({
        id: chat.chat_uid as string,
        label: chat.title as string,
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

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    const answer = await new Promise<string>((resolve) => {
      rl.question(chalk.yellow(`  Delete "${(choice.value as Record<string, unknown>).title}"? This cannot be undone. (y/N) `), (ans) => {
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

    if (activeChat?.chatUid === choice.id) {
      await clearActiveChat()
    }

    console.log("")
    console.log(chalk.green(`  ✓ Deleted: ${(choice.value as Record<string, unknown>).title}`))
    console.log("")
  } catch (err) {
    console.log(chalk.red(`  ${(err as Error).message}`))
    console.log("")
  }
}

export async function ensureActiveChat(): Promise<string | null> {
  const token = await getAuthToken()
  if (!token) return null

  const existing = await getActiveChatInfo()
  if (existing?.chatUid) return existing.chatUid as string

  const projectId = path.basename(process.cwd())

  try {
    const { chats } = await apiGet(`/chats?projectId=${encodeURIComponent(projectId)}`) as { chats: Array<Record<string, unknown>> }

    if (chats && chats.length > 0) {
      const latest = chats[0]
      await saveActiveChat(latest.chat_uid as string, latest.title as string)
      return latest.chat_uid as string
    }

    const { chat } = await apiPost("/chats", {
      projectId,
      title: "Chat 1"
    }) as { chat: Record<string, unknown> }
    await saveActiveChat(chat.chat_uid as string, chat.title as string)
    return chat.chat_uid as string
  } catch {
    return null
  }
}

function timeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000)
  if (seconds < 60) return "just now"
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86400)}d ago`
}
