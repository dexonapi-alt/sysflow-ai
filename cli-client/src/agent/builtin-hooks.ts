/**
 * Built-in hooks: audit log + secrets-block.
 *
 * registerBuiltinHooks() is idempotent — it's safe to call from process startup
 * even if the executor is later imported again. Hooks that need state hold it
 * in module-local closures.
 */

import { registerHook, type Hook, type HookContext } from "./hooks.js"
import { primaryPath } from "./permissions.js"
import { getSysbasePath } from "../lib/sysbase.js"
import { appendAudit } from "./audit-log.js"

const SECRET_PATH_RE = [
  /(^|\/)\.env(\.[^/]+)?$/,                 // .env, .env.local — but NOT .env.example
  /\.pem$/i,
  /(^|\/)id_rsa(\.[^/]+)?$/i,
  /(^|\/)secrets\.(json|ya?ml|toml)$/i,
  /(^|\/)credentials(\.[^/]+)?$/i,
]
const SECRET_ALLOWLIST_RE = [/\.example$/i, /\.sample$/i, /\.template$/i]

const WRITE_TOOLS = new Set(["write_file", "edit_file", "batch_write"])

let registered = false

export function registerBuiltinHooks(): void {
  if (registered) return
  registered = true
  registerHook("pre_tool_use", secretsBlockHook, "builtin/secrets-block")
  registerHook("post_tool_use", auditHook, "builtin/audit")
  registerHook("post_tool_use_failure", auditHook, "builtin/audit")
}

const secretsBlockHook: Hook = (ctx: HookContext) => {
  if (!WRITE_TOOLS.has(ctx.tool)) return
  const target = primaryPath(ctx.tool, ctx.args)
  if (!target) return
  const isAllowed = SECRET_ALLOWLIST_RE.some((re) => re.test(target))
  if (isAllowed) return
  const looksSecret = SECRET_PATH_RE.some((re) => re.test(target))
  if (!looksSecret) return
  return {
    override: "deny",
    note: `secrets-block: refused to ${ctx.tool} ${target} (matches secret path pattern)`,
  }
}

const auditHook: Hook = async (ctx: HookContext) => {
  const sysbasePath = getSysbasePath()
  if (!sysbasePath) return
  await appendAudit(sysbasePath, {
    ts: new Date().toISOString(),
    event: ctx.event,
    runId: ctx.runId ?? null,
    tool: ctx.tool,
    args: redact(ctx.args),
    success: ctx.event === "post_tool_use" ? true : ctx.event === "post_tool_use_failure" ? false : null,
    errorCategory: ctx.result?._errorCategory ?? null,
  })
}

/** Strip large fields from args before writing to the audit log. */
function redact(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === "string" && v.length > 200) out[k] = `<${v.length} chars>`
    else out[k] = v
  }
  return out
}
