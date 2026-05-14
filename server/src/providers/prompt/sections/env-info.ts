/**
 * Environment info. Non-cacheable — changes per request based on cwd, model,
 * platform, and the date. Goes AFTER the dynamic boundary.
 */

import os from "node:os"

export interface EnvInfoCtx {
  cwd?: string
  model?: string
  platform?: string
  /** Optional git branch sent through from the client. */
  gitBranch?: string
  /** Optional truncated git status sent through from the client. */
  gitStatus?: string
}

export function getEnvInfoSection(ctx: EnvInfoCtx = {}): string {
  const platform = ctx.platform ?? process.platform
  const isWindows = platform === "win32"

  const lines: string[] = ["═══ ENVIRONMENT ═══", ""]
  if (ctx.cwd) lines.push(`- cwd: ${ctx.cwd}`)
  lines.push(`- platform: ${platform}`)
  lines.push(`- os: ${os.type()} ${os.release()}`)
  lines.push(`- node: ${process.version}`)
  if (ctx.model) lines.push(`- model: ${ctx.model}`)
  lines.push(`- date: ${new Date().toISOString().slice(0, 10)}`)
  if (ctx.gitBranch) lines.push(`- git branch: ${ctx.gitBranch}`)
  if (ctx.gitStatus) {
    const truncated = ctx.gitStatus.length > 500 ? ctx.gitStatus.slice(0, 500) + "..." : ctx.gitStatus
    lines.push(`- git status:\n${truncated}`)
  }
  // Stage 1 of command-first-investigation: surface a tight list of
  // platform-correct investigation commands so the model doesn't reach
  // for bash equivalents on Windows (which would error and waste a turn).
  // The full pattern library lives in `investigation.ts`; this is the
  // env-info echo so the model has the platform binding next to the
  // platform identifier.
  lines.push("")
  lines.push(`- preferred read-only commands (${isWindows ? "PowerShell" : "bash"}):`)
  if (isWindows) {
    lines.push("    Get-ChildItem, Select-String, Get-Content, Test-Path, Get-Command, git status / log / diff, npm list")
  } else {
    lines.push("    ls, find, grep, cat, head, tail, which, git status / log / diff, npm list")
  }
  return lines.join("\n")
}
