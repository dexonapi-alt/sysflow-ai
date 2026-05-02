/**
 * Hook registry: pre/post tool-use hooks that can override permissions,
 * prevent execution, or inject context that future calls see.
 *
 * Hook ordering: registration order. The first hook to return a non-undefined
 * `override` wins. The first hook to return `prevent: true` short-circuits
 * execution; remaining hooks for that event still run (so audit hooks always
 * fire) but their `override` and `prevent` are ignored.
 *
 * Hooks are pure data passing — they don't mutate the tool args. Mutating the
 * world (writing audit logs, etc.) is fine inside a hook; it just shouldn't
 * touch the args object.
 */

import type { PermissionDecision } from "./permissions.js"

export type HookEvent = "pre_tool_use" | "post_tool_use" | "post_tool_use_failure"

export interface HookContext {
  event: HookEvent
  tool: string
  args: Record<string, unknown>
  runId?: string
  /** Only set for post_tool_use / post_tool_use_failure. */
  result?: Record<string, unknown>
  /** Only set for post_tool_use_failure. */
  error?: Error
}

export interface HookResult {
  /** When set, replaces the permission decision (only honoured for pre_tool_use). */
  override?: PermissionDecision
  /** When true, skip tool execution entirely (only honoured for pre_tool_use). */
  prevent?: boolean
  /** Free-form note appended to audit logs / debug output. */
  note?: string
  /** Identifier for tracing — defaults to the hook function name. */
  source?: string
}

export type Hook = (ctx: HookContext) => HookResult | void | Promise<HookResult | void>

interface RegisteredHook {
  hook: Hook
  source: string
}

const hooks: Record<HookEvent, RegisteredHook[]> = {
  pre_tool_use: [],
  post_tool_use: [],
  post_tool_use_failure: [],
}

export function registerHook(event: HookEvent, hook: Hook, source: string): void {
  hooks[event].push({ hook, source })
}

export function clearHooks(event?: HookEvent): void {
  if (event) hooks[event] = []
  else {
    hooks.pre_tool_use = []
    hooks.post_tool_use = []
    hooks.post_tool_use_failure = []
  }
}

export interface HookSummary {
  override?: PermissionDecision
  prevent: boolean
  notes: Array<{ source: string; note: string }>
}

export async function runHooks(event: HookEvent, ctx: HookContext): Promise<HookSummary> {
  const summary: HookSummary = { prevent: false, notes: [] }
  for (const { hook, source } of hooks[event]) {
    let res: HookResult | void
    try {
      res = await hook(ctx)
    } catch (err) {
      console.warn(`[hook] '${source}' threw on ${event}:`, (err as Error).message)
      continue
    }
    if (!res) continue
    const tag = res.source ?? source
    if (res.note) summary.notes.push({ source: tag, note: res.note })
    if (event === "pre_tool_use") {
      if (summary.override === undefined && res.override !== undefined) summary.override = res.override
      if (!summary.prevent && res.prevent === true) summary.prevent = true
    }
  }
  return summary
}
