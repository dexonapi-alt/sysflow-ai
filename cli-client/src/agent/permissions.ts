/**
 * Permission system: modes, per-tool defaults, persistent rules, decision lookup.
 *
 * Modes (highest authority first):
 *   - bypass  — every tool call is allowed; no prompts. Use for trusted automation.
 *   - auto    — auto-allow read-only tools; for everything else, prompt once per
 *               (tool, path-glob) and remember the answer for the rest of the run.
 *   - default — consult per-tool defaultPermission and persistent rules; prompt on 'ask'.
 *   - plan    — read-only tools allowed; everything else denied (used by future plan-mode).
 *
 * Rules (Rule[]) live on disk in <sysbasePath>/permissions.json. Each rule
 * names a tool plus an optional glob pattern (matched against the tool's
 * primary path argument). Longest pattern wins. Decision is one of allow|deny|ask.
 */

import fs from "node:fs/promises"
import path from "node:path"
import { getToolMeta } from "./tool-meta.js"

export type PermissionMode = "default" | "auto" | "plan" | "bypass"
export type PermissionDecision = "allow" | "deny" | "ask"

export interface Rule {
  tool: string
  /** Glob pattern matched against the tool's primary path arg. Empty = matches any. */
  pattern?: string
  decision: PermissionDecision
}

export interface CheckArgs {
  tool: string
  args: Record<string, unknown>
  mode: PermissionMode
  rules: Rule[]
}

export interface CheckResult {
  decision: PermissionDecision
  /** Why we made this decision — used in the audit log + UI. */
  source: "mode" | "rule" | "tool_default"
  /** When source='rule', the rule that matched. */
  matchedRule?: Rule
}

export function checkPermissions({ tool, args, mode, rules }: CheckArgs): CheckResult {
  // Mode-level overrides first.
  if (mode === "bypass") return { decision: "allow", source: "mode" }
  if (mode === "plan") {
    return getToolMeta(tool).isReadOnly
      ? { decision: "allow", source: "mode" }
      : { decision: "deny", source: "mode" }
  }

  // Persistent rules — longest-pattern-wins.
  const targetPath = primaryPath(tool, args)
  const matching = rules
    .filter((r) => r.tool === tool || r.tool === "*")
    .filter((r) => !r.pattern || (targetPath != null && matchesGlob(targetPath, r.pattern)))
    .sort((a, b) => (b.pattern?.length ?? 0) - (a.pattern?.length ?? 0))
  if (matching.length > 0) {
    return { decision: matching[0].decision, source: "rule", matchedRule: matching[0] }
  }

  // Per-tool default. 'auto' mode flips read-only ask defaults to allow but
  // leaves the rest as ask (user still confirms once per pattern).
  const meta = getToolMeta(tool)
  const def = meta.defaultPermission ?? "ask"
  if (mode === "auto" && meta.isReadOnly && def === "ask") {
    return { decision: "allow", source: "tool_default" }
  }
  return { decision: def, source: "tool_default" }
}

/** Extract the tool's primary path arg for rule matching. Falls back to null. */
export function primaryPath(tool: string, args: Record<string, unknown>): string | null {
  if (typeof args.path === "string") return args.path
  if (typeof args.from === "string") return args.from
  if (tool === "run_command" && typeof args.command === "string") return args.command
  return null
}

/**
 * Tiny glob matcher: supports `*` (matches anything except `/`), `**` (matches
 * across `/`), and literal text. No character classes. Pattern matched against
 * the entire input string.
 */
export function matchesGlob(input: string, pattern: string): boolean {
  const re = new RegExp(
    "^" +
      pattern
        .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, "::DOUBLESTAR::")
        .replace(/\*/g, "[^/]*")
        .replace(/::DOUBLESTAR::/g, ".*")
      + "$",
  )
  return re.test(input)
}

// ─── Persistent rules + run-scoped cache ───

const RULES_FILE = "permissions.json"

export async function loadRules(sysbasePath: string | undefined | null): Promise<Rule[]> {
  if (!sysbasePath) return []
  try {
    const body = await fs.readFile(path.join(sysbasePath, RULES_FILE), "utf8")
    const parsed = JSON.parse(body)
    if (Array.isArray(parsed)) return parsed.filter((r): r is Rule => isRule(r))
    return []
  } catch {
    return []
  }
}

export async function saveRule(sysbasePath: string | undefined | null, rule: Rule): Promise<void> {
  if (!sysbasePath) return
  const existing = await loadRules(sysbasePath)
  const filtered = existing.filter((r) => !(r.tool === rule.tool && (r.pattern ?? "") === (rule.pattern ?? "")))
  filtered.push(rule)
  try {
    await fs.mkdir(sysbasePath, { recursive: true })
    await fs.writeFile(path.join(sysbasePath, RULES_FILE), JSON.stringify(filtered, null, 2), "utf8")
  } catch (err) {
    console.warn(`[permissions] Failed to persist rule:`, (err as Error).message)
  }
}

export async function removeRule(sysbasePath: string | undefined | null, tool: string, pattern: string | undefined): Promise<boolean> {
  if (!sysbasePath) return false
  const existing = await loadRules(sysbasePath)
  const filtered = existing.filter((r) => !(r.tool === tool && (r.pattern ?? "") === (pattern ?? "")))
  if (filtered.length === existing.length) return false
  try {
    await fs.writeFile(path.join(sysbasePath, RULES_FILE), JSON.stringify(filtered, null, 2), "utf8")
    return true
  } catch {
    return false
  }
}

function isRule(v: unknown): v is Rule {
  if (!v || typeof v !== "object") return false
  const r = v as Record<string, unknown>
  if (typeof r.tool !== "string") return false
  if (r.pattern != null && typeof r.pattern !== "string") return false
  if (r.decision !== "allow" && r.decision !== "deny" && r.decision !== "ask") return false
  return true
}

// ─── Run-scoped session cache (per-run answers to 'ask') ───

const sessionCache = new Map<string, Map<string, PermissionDecision>>()

export function rememberAnswer(runId: string, tool: string, pattern: string | null, decision: PermissionDecision): void {
  if (!sessionCache.has(runId)) sessionCache.set(runId, new Map())
  sessionCache.get(runId)!.set(`${tool}::${pattern ?? "*"}`, decision)
}

export function lookupAnswer(runId: string, tool: string, pattern: string | null): PermissionDecision | null {
  return sessionCache.get(runId)?.get(`${tool}::${pattern ?? "*"}`) ?? null
}

export function clearRunAnswers(runId: string): void {
  sessionCache.delete(runId)
}
