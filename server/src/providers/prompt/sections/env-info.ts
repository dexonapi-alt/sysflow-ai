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
  const lines: string[] = ["═══ ENVIRONMENT ═══", ""]
  if (ctx.cwd) lines.push(`- cwd: ${ctx.cwd}`)
  lines.push(`- platform: ${ctx.platform ?? process.platform}`)
  lines.push(`- os: ${os.type()} ${os.release()}`)
  lines.push(`- node: ${process.version}`)
  if (ctx.model) lines.push(`- model: ${ctx.model}`)
  lines.push(`- date: ${new Date().toISOString().slice(0, 10)}`)
  if (ctx.gitBranch) lines.push(`- git branch: ${ctx.gitBranch}`)
  if (ctx.gitStatus) {
    const truncated = ctx.gitStatus.length > 500 ? ctx.gitStatus.slice(0, 500) + "..." : ctx.gitStatus
    lines.push(`- git status:\n${truncated}`)
  }
  return lines.join("\n")
}
