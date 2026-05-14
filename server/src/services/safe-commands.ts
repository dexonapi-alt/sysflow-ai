/**
 * Stage 4 of command-first-investigation plan: server-side mirror of the
 * cli-client's safe-command allowlist. The handler needs to know whether
 * a `run_command` was an investigation call so it can count those calls
 * for the `no_investigation_before_write` divergence heuristic.
 *
 * Kept logically in sync with `cli-client/src/agent/safe-commands.ts` —
 * any drift here only affects which commands COUNT as investigation in
 * the heuristic (server-side); the cli-client's copy still gates
 * permission auto-approval. If the cli-client whitelist gets a new
 * entry, mirror it here too so the count matches the auto-approve set.
 *
 * Conservative by design — when in doubt, NOT safe.
 *
 * Pure module — no I/O, no state. Exported for unit tests.
 */

const SAFE_LEADING = new Set([
  "ls", "find", "grep", "rg", "cat", "type", "head", "tail", "wc", "du", "tree",
  "which", "where", "whoami", "pwd", "hostname", "uname", "env",
  "echo", "jq", "date",
  "dir",
])

const SAFE_POWERSHELL = new Set([
  "get-childitem", "get-content", "get-location", "get-command", "get-help",
  "get-item", "get-itemproperty", "get-process", "get-date",
  "select-string", "measure-object", "test-path", "convertfrom-json",
  "out-string", "where-object", "select-object",
])

const SAFE_GIT_SUBS = new Set([
  "status", "log", "diff", "show", "blame",
  "ls-files", "ls-tree", "rev-parse", "rev-list",
  "tag", "describe", "shortlog",
])

const SAFE_NPM_SUBS = new Set([
  "list", "ls", "outdated", "view", "info", "explain", "config",
])

const SAFE_CARGO_SUBS = new Set([
  "metadata", "tree", "search", "version", "help",
])

const SAFE_PIP_SUBS = new Set(["list", "show", "search", "help"])

const VERSION_HEADS = new Set([
  "node", "python", "python3", "ruby", "go", "deno", "bun", "rustc",
  "java", "javac", "perl", "php", "dotnet",
])
const VERSION_ARG_RE = /^(-v|-V|--version)$/

const FORBIDDEN_RE = /&&|\|\||;|\||>|<|`|\$\(/

export function isSafeReadOnlyCommand(rawCmd: unknown): boolean {
  if (typeof rawCmd !== "string") return false
  const cmd = rawCmd.trim()
  if (cmd.length === 0) return false

  if (FORBIDDEN_RE.test(cmd)) return false

  const tokens = cmd.split(/\s+/)
  const head = tokens[0]
  const sub = tokens[1] ?? ""

  if (VERSION_HEADS.has(head)) return VERSION_ARG_RE.test(sub)

  if (SAFE_LEADING.has(head)) return true

  if (head === "git") return SAFE_GIT_SUBS.has(sub)
  if (head === "npm" || head === "pnpm" || head === "yarn") return SAFE_NPM_SUBS.has(sub)
  if (head === "cargo") return SAFE_CARGO_SUBS.has(sub)
  if (head === "pip" || head === "pip3") return SAFE_PIP_SUBS.has(sub)

  if (SAFE_POWERSHELL.has(head.toLowerCase())) return true

  return false
}
