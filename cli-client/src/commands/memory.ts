/**
 * CLI wrappers for the /memory and /remember slash commands.
 *
 * Talks to the server's memory routes — keeps file I/O on the server
 * side so the CLI doesn't grow a memory-store dependency.
 */

import { colors, BOX } from "../cli/render.js"
import { getAuthToken } from "../lib/sysbase.js"

const SERVER_URL = process.env.SYS_SERVER_URL || "http://localhost:4000"

interface MemoryEntryView {
  id: string
  kind: string
  content: string
  status: string
  useCount: number
  contradictionCount: number
  createdAt: number
  lastConfirmedAt: number
  lastUsedAt: number
  staleReasons?: string[]
}

interface ListResp {
  ok: boolean
  summary?: { total: number; active: number; stale: number; contradicted: number }
  entries?: MemoryEntryView[]
  error?: string
}

async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = (await getAuthToken()) || process.env.SYS_TOKEN || ""
  return fetch(`${SERVER_URL}${path}`, {
    ...init,
    headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${token}` },
  })
}

function statusColor(s: string): (s: string) => string {
  if (s === "active") return colors.success
  if (s === "stale") return colors.warning
  if (s === "contradicted") return colors.error
  return colors.muted
}

function ageDays(ms: number): string {
  const days = Math.floor((Date.now() - ms) / 86_400_000)
  if (days < 1) return "<1d"
  return `${days}d`
}

export async function showMemoryList(): Promise<void> {
  const cwd = process.cwd()
  const res = await authedFetch(`/memory/list?cwd=${encodeURIComponent(cwd)}`)
  if (!res.ok) {
    console.log("  " + colors.error(`memory list failed: ${res.status}`))
    return
  }
  const data = await res.json() as ListResp
  if (!data.ok) {
    console.log("  " + colors.error(data.error ?? "unknown error"))
    return
  }

  console.log("")
  console.log("  " + colors.accent.bold("memory") + colors.muted(`  ·  ${cwd}`))
  if (data.summary) {
    console.log("  " + colors.muted(
      `total: ${data.summary.total}  ·  ` +
      colors.success(`${data.summary.active} active`) +
      colors.muted("  ·  ") +
      colors.warning(`${data.summary.stale} stale`) +
      colors.muted("  ·  ") +
      colors.error(`${data.summary.contradicted} contradicted`),
    ))
  }
  console.log("")
  if (!data.entries || data.entries.length === 0) {
    console.log("  " + colors.muted("(no entries — agent will record decisions + summaries as you go)"))
    console.log("")
    return
  }
  for (const e of data.entries) {
    const sc = statusColor(e.status)
    const tag = `${sc(`[${e.status}]`)} ${colors.muted(e.kind.padEnd(16))}`
    const meta = colors.muted(`use=${e.useCount}  age=${ageDays(e.createdAt)}  conf=${ageDays(e.lastConfirmedAt)}  contradictions=${e.contradictionCount}`)
    console.log(`  ${colors.muted(e.id)}  ${tag}`)
    console.log(`     ${colors.bright(e.content)}`)
    console.log(`     ${meta}`)
    if (e.staleReasons && e.staleReasons.length > 0) {
      console.log(`     ${colors.warning("stale because: ")}${colors.muted(e.staleReasons.join("; "))}`)
    }
    console.log("")
  }
  console.log("  " + colors.muted("/memory forget <id>  ·  /memory clear stale  ·  /memory clear all confirm  ·  /remember \"...\""))
  console.log("")
}

export async function forgetMemoryEntry(id: string): Promise<void> {
  const cwd = process.cwd()
  const res = await authedFetch(`/memory/${encodeURIComponent(id)}?cwd=${encodeURIComponent(cwd)}`, { method: "DELETE" })
  const data = await res.json() as { ok: boolean }
  if (data.ok) {
    console.log("  " + colors.success(`forgot ${id}`))
  } else {
    console.log("  " + colors.muted(`no entry ${id}`))
  }
}

export async function clearStaleEntries(): Promise<void> {
  const cwd = process.cwd()
  const res = await authedFetch(`/memory/stale?cwd=${encodeURIComponent(cwd)}`, { method: "DELETE" })
  const data = await res.json() as { ok: boolean; removed?: number }
  if (data.ok) {
    console.log("  " + colors.success(`cleared ${data.removed ?? 0} stale/contradicted entries`))
  } else {
    console.log("  " + colors.error("failed to clear stale entries"))
  }
}

export async function clearAllEntries(confirmed: boolean): Promise<void> {
  const cwd = process.cwd()
  const url = `/memory/all?cwd=${encodeURIComponent(cwd)}` + (confirmed ? "&confirm=confirm" : "")
  const res = await authedFetch(url, { method: "DELETE" })
  const data = await res.json() as { ok: boolean; requiresConfirmation?: boolean; count?: number; hint?: string }
  if (data.requiresConfirmation) {
    console.log("")
    console.log("  " + BOX.cross + " " + colors.warning(`This will wipe ALL ${data.count ?? "?"} memory entries.`))
    console.log("  " + colors.muted("Run `/memory clear all confirm` to actually do it."))
    console.log("")
    return
  }
  if (data.ok) {
    console.log("  " + colors.success("memory wiped"))
  } else {
    console.log("  " + colors.error("wipe failed"))
  }
}

export async function recordExplicitMemory(text: string): Promise<void> {
  if (!text || !text.trim()) {
    console.log("  " + colors.error("usage: /remember \"text to remember\""))
    return
  }
  const cwd = process.cwd()
  const res = await authedFetch(`/memory/remember`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, text }),
  })
  const data = await res.json() as { ok: boolean; entry?: MemoryEntryView; error?: string }
  if (data.ok && data.entry) {
    console.log("  " + colors.success(`remembered [${data.entry.id}]`) + colors.muted(`  · /memory list to view`))
  } else {
    console.log("  " + colors.error(data.error ?? "could not record"))
  }
}
