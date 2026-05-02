/**
 * Tool-result preview — replaces the silent "thinking..." spinner gap between
 * tool execution and the next model call with a one-line preview of what
 * actually came back.
 *
 * Pure rendering. Returns null when there is nothing useful to show, so the
 * caller can decide whether to print a blank line or skip entirely.
 */

import { colors, BOX } from "./render.js"

export interface PreviewableResult {
  tool: string
  result: Record<string, unknown> | undefined
}

const MAX_PREVIEW_CHARS = 200

export function renderToolResultPreview({ tool, result }: PreviewableResult): string | null {
  if (!result) return null
  if (result.aborted_by_sibling) {
    return `      ${colors.muted(BOX.dash)} ${colors.warning("↯ aborted")} ${colors.muted("(sibling failed)")}`
  }
  if (result.error && typeof result.error === "string") {
    return `      ${colors.muted(BOX.dash)} ${colors.error("error:")} ${colors.muted(truncate(result.error))}`
  }
  if (result._truncated) {
    const original = result._original_size as number | undefined
    return `      ${colors.muted(BOX.dash)} ${colors.warning("truncated")} ${colors.muted(original ? `(${original} chars)` : "")}`
  }
  if (result._persistedPath) {
    const sz = result._persistedSize as number | undefined
    return `      ${colors.muted(BOX.dash)} ${colors.muted(`archived to disk${sz ? ` (${Math.round(sz / 1024)} KiB)` : ""}`)}`
  }

  switch (tool) {
    case "read_file":
    case "batch_read":
      return previewRead(result)
    case "search_code":
      return previewSearch(result, "matches")
    case "search_files":
      return previewSearch(result, "files")
    case "list_directory":
      return previewList(result)
    case "run_command":
      return previewCommand(result)
    case "web_search":
      return previewWebSearch(result)
    case "write_file":
    case "edit_file":
      return previewWrite(result)
    default:
      return null
  }
}

function previewRead(result: Record<string, unknown>): string | null {
  const content = (result.content as string) || (result.data as string) || ""
  if (!content) return null
  const firstLines = content.split("\n").slice(0, 3).join(" ⏎ ")
  return `      ${colors.muted(BOX.dash)} ${colors.muted(truncate(firstLines))}`
}

function previewSearch(result: Record<string, unknown>, kind: "matches" | "files"): string | null {
  const raw = result.results
  if (Array.isArray(raw)) {
    return `      ${colors.muted(BOX.dash)} ${colors.muted(`${raw.length} ${kind}`)}`
  }
  if (typeof raw === "string") {
    const lines = raw.split("\n").filter((l) => l.trim() && !l.startsWith("No "))
    return `      ${colors.muted(BOX.dash)} ${colors.muted(`${lines.length} ${kind}`)}`
  }
  return null
}

function previewList(result: Record<string, unknown>): string | null {
  const entries = result.entries || result.items
  if (Array.isArray(entries)) {
    return `      ${colors.muted(BOX.dash)} ${colors.muted(`${entries.length} entries`)}`
  }
  return null
}

function previewCommand(result: Record<string, unknown>): string | null {
  const exitCode = (result.exitCode ?? result.code) as number | undefined
  const stdout = (result.stdout as string) || ""
  const stderr = (result.stderr as string) || ""
  const tail = (stdout || stderr).split("\n").filter((l) => l.trim()).slice(-1)[0] || ""
  if (exitCode != null) {
    const status = exitCode === 0 ? colors.success(`exit 0`) : colors.error(`exit ${exitCode}`)
    return `      ${colors.muted(BOX.dash)} ${status}${tail ? " " + colors.muted(truncate(tail)) : ""}`
  }
  if (tail) return `      ${colors.muted(BOX.dash)} ${colors.muted(truncate(tail))}`
  return null
}

function previewWebSearch(result: Record<string, unknown>): string | null {
  const results = result.results
  if (Array.isArray(results)) {
    return `      ${colors.muted(BOX.dash)} ${colors.muted(`${results.length} hits`)}`
  }
  return null
}

function previewWrite(result: Record<string, unknown>): string | null {
  if (result.success === false) return null
  const path = (result.path as string) || ""
  const bytes = (result.bytesWritten as number) || (result.bytes as number)
  if (bytes != null) {
    return `      ${colors.muted(BOX.dash)} ${colors.success("wrote")} ${colors.muted(`${bytes} bytes`)}${path ? colors.muted(` ${path}`) : ""}`
  }
  return null
}

function truncate(s: string): string {
  const collapsed = s.replace(/\s+/g, " ").trim()
  if (collapsed.length <= MAX_PREVIEW_CHARS) return collapsed
  return collapsed.slice(0, MAX_PREVIEW_CHARS) + "…"
}
