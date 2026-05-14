/**
 * Stage 2 of command-first-investigation plan: regex-based allowlist for
 * read-only investigation commands that auto-approve without prompting.
 *
 * Without this, every `git status` / `ls` / `grep` during investigation
 * fires the permission prompt — turning Stage 1's investigation-first
 * directive into a permission-prompt firehose. The allowlist matches
 * the canonical investigation set conservatively: only known-safe
 * leading commands + tight subcommand whitelists, anything that
 * chains/pipes/redirects falls through to the existing ask gate.
 *
 * Conservative by design — when in doubt, NOT safe. The existing ask
 * gate handles anything the allowlist doesn't recognise, so false
 * negatives are merely "one extra prompt" while false positives could
 * auto-run something destructive.
 *
 * Pure module — no I/O, no state. Exported for unit tests.
 */

/** Leading commands that are universally read-only (any args allowed). */
const SAFE_LEADING = new Set([
  // Unix file/dir/text inspection
  "ls", "find", "grep", "rg", "cat", "type", "head", "tail", "wc", "du", "tree",
  // Process / environment info
  "which", "where", "whoami", "pwd", "hostname", "uname", "env",
  // Inert utilities
  "echo", "jq", "date",
  // Windows CMD built-ins
  "dir",
])

/** PowerShell cmdlets (case-insensitive match). All read-only by name. */
const SAFE_POWERSHELL = new Set([
  "get-childitem", "get-content", "get-location", "get-command", "get-help",
  "get-item", "get-itemproperty", "get-process", "get-date",
  "select-string", "measure-object", "test-path", "convertfrom-json",
  "out-string", "where-object", "select-object",
])

/** git subcommands that CANNOT modify the repo. */
const SAFE_GIT_SUBS = new Set([
  "status", "log", "diff", "show", "blame",
  "ls-files", "ls-tree", "rev-parse", "rev-list",
  "tag",   // bare `git tag` lists; tag-with-create needs args we don't enforce
  "describe", "shortlog",
])

/** npm-family read-only subcommands. */
const SAFE_NPM_SUBS = new Set([
  "list", "ls", "outdated", "view", "info", "explain", "config",
])

/** cargo read-only subcommands. */
const SAFE_CARGO_SUBS = new Set([
  "metadata", "tree", "search", "version", "help",
])

/** pip read-only subcommands. */
const SAFE_PIP_SUBS = new Set(["list", "show", "search", "help"])

/**
 * Version-query commands. These leading commands ONLY auto-approve when
 * the immediate argument is a version flag — `node` alone could spawn
 * a REPL or run arbitrary code, `node --version` is inert.
 */
const VERSION_HEADS = new Set([
  "node", "python", "python3", "ruby", "go", "deno", "bun", "rustc",
  "java", "javac", "perl", "php", "dotnet",
])
// `cargo` / `pip` / `npm` ARE NOT in VERSION_HEADS — they have their own
// subcommand whitelists below. The version-only check is for runtimes
// that could spawn a REPL or run arbitrary code if invoked without args.
const VERSION_ARG_RE = /^(-v|-V|--version)$/

/**
 * Forbidden anywhere in the command. Catches shell metacharacters that
 * could chain a write or invoke a sub-shell:
 *   &&  ||  ;          — chain operators
 *   |                  — any pipe (even to read-only `head`, conservative)
 *   >  <  >>  <<       — redirections
 *   `...`              — command substitution (backtick)
 *   $(...)             — command substitution (dollar-paren)
 *
 * Quoted occurrences ARE flagged too. False negatives (over-blocking
 * commands that quote a `>` inside a search pattern, e.g.
 * `grep '>' file`) trigger the ask gate, which is the safer failure
 * mode than silently running a destructive command.
 */
const FORBIDDEN_RE = /&&|\|\||;|\||>|<|`|\$\(/

/**
 * True iff the command is safe to auto-approve as a read-only investigation
 * call. Conservative — anything ambiguous returns false.
 */
export function isSafeReadOnlyCommand(rawCmd: unknown): boolean {
  if (typeof rawCmd !== "string") return false
  const cmd = rawCmd.trim()
  if (cmd.length === 0) return false

  // Reject any shell metacharacters that could chain or sub-shell. This
  // is the load-bearing safety check — even when each piece is
  // individually safe, the combination is hard to reason about.
  if (FORBIDDEN_RE.test(cmd)) return false

  // Split on whitespace; the first token is the leading command.
  const tokens = cmd.split(/\s+/)
  const head = tokens[0]
  const sub = tokens[1] ?? ""

  // Version-query commands only.
  if (VERSION_HEADS.has(head)) return VERSION_ARG_RE.test(sub)

  // Leading commands with no subcommand restriction.
  if (SAFE_LEADING.has(head)) return true

  // Compound commands with a subcommand whitelist.
  if (head === "git") return SAFE_GIT_SUBS.has(sub)
  if (head === "npm" || head === "pnpm" || head === "yarn") return SAFE_NPM_SUBS.has(sub)
  if (head === "cargo") return SAFE_CARGO_SUBS.has(sub)
  if (head === "pip" || head === "pip3") return SAFE_PIP_SUBS.has(sub)

  // PowerShell cmdlets (case-insensitive — `Get-ChildItem` and
  // `get-childitem` both match).
  if (SAFE_POWERSHELL.has(head.toLowerCase())) return true

  return false
}
