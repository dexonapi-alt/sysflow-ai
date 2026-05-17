/**
 * Stage 4 of `2026-05-16-awareness-and-verification-correctness.md`.
 *
 * Windows-specific preprocessing + post-execution error detection
 * for shell commands routed through PowerShell.
 *
 * THE BUG (user report 2026-05-16):
 *
 *   ● Bash(ls -la)
 *   ─ + FullyQualifiedErrorId : NamedParameterNotFound,Microsoft.PowerShell.Commands.GetChildItemCommand
 *   ✔ ls -la
 *
 *   PowerShell aliases `ls → Get-ChildItem`. `Get-ChildItem -la` is
 *   parsed by PowerShell's parameter binder, which rejects `-la`
 *   (NamedParameterNotFound) with a non-terminating ErrorRecord on
 *   stderr. `$LASTEXITCODE` stays at whatever it was before (often
 *   0), so `; exit $LASTEXITCODE` exits 0. The cli treats code=0
 *   as success and reports `✔` — but the cmdlet never actually ran.
 *   User sees BOTH the error AND `✔` — bad signal.
 *
 * Two-pronged fix:
 *
 *   1. `remapWindowsShellCommand` — preprocesses common Unix-style
 *      aliases that break under PowerShell into their PowerShell
 *      equivalents BEFORE dispatch. `ls -la` → `Get-ChildItem -Force`.
 *      Preserves the original command so the agent's tool-result
 *      envelope can include it for reasoning + so the cli's display
 *      shows the agent what was asked vs what ran.
 *
 *   2. `detectPowerShellError` — inspects stderr for PowerShell
 *      cmdlet error markers. When detected, the call site marks
 *      `success: false` regardless of exit code. The shell exited
 *      cleanly but the cmdlet itself rejected its args; reporting
 *      success would be a lie.
 *
 * Why two prongs:
 *
 *   Pong 1 catches the common shapes the LLM emits (it sees `ls -la`
 *   in its training data and reaches for it). Prong 2 catches the
 *   long tail — any cmdlet binding error on any command, mapped or
 *   not. Pong 1 reduces the rate at which Prong 2 fires; Prong 2
 *   ensures the failure surfaces honestly when Pong 1 missed.
 *
 * Pure module — no I/O. Both helpers are exported for direct testing.
 */

export interface WindowsShellRemap {
  /** The command that will actually be sent to the shell. */
  command: string
  /**
   * The ORIGINAL command — non-null only when a remap occurred.
   * Threaded into the run_command result envelope so the agent can
   * see what it asked for vs what ran, and so logs preserve the
   * pre-remap form for debugging.
   */
  originalCommand: string | null
}

/**
 * Ordered list of remap patterns. First match wins. Patterns are
 * anchored to the start of the trimmed command. We deliberately do
 * NOT try to handle every Unix-form the LLM might emit — only the
 * common shapes that:
 *
 *   (a) the LLM emits frequently (training-data inheritance), AND
 *   (b) PowerShell rejects with a parameter-binding error, AND
 *   (c) have a clean one-shot PowerShell equivalent.
 *
 * Grep / find / sed / awk / tar / xargs and friends are NOT remapped
 * — their PowerShell equivalents differ structurally (different
 * cmdlet semantics, different output shape) and a naive 1:1 rewrite
 * would produce surprising results. For those, Prong 2's stderr
 * inspection catches the failure and the agent rephrases.
 *
 * Each entry's `rewrite` takes the full RegExp match array and
 * returns the substituted PowerShell command.
 */
const UNIX_ALIAS_REMAPS: ReadonlyArray<{
  pattern: RegExp
  rewrite: (match: RegExpMatchArray) => string
  description: string
}> = [
  // `ls -la <path>` / `ls -al <path>` (path must not start with `-`
  // and must not contain shell pipes / redirects — that's how we
  // exclude `ls -la -h` (extra flag) and `ls -la | grep foo` (piped)
  // from naive remapping. For those shapes, Prong 2 catches the
  // residual PowerShell error.
  //
  // `-Force` shows hidden + dotfiles which is what `-a` semantically
  // requests. Default `Get-ChildItem` already returns enough columns
  // for the agent to reason — no `-l` equivalent needed.
  {
    pattern: /^ls\s+-(?:la|al|lA|La|aL|Al)\s+([^-|<>;][^|<>;]*)$/,
    rewrite: (m) => `Get-ChildItem -Force ${m[1].trim()}`,
    description: "ls -la <path> → Get-ChildItem -Force <path>",
  },
  // `ls -la` / `ls -al` (no path, current dir).
  {
    pattern: /^ls\s+-(?:la|al|lA|La|aL|Al)$/,
    rewrite: () => "Get-ChildItem -Force",
    description: "ls -la → Get-ChildItem -Force",
  },
  // `ls -a <path>` / `ls -A <path>`.
  {
    pattern: /^ls\s+-[aA]\s+([^-|<>;][^|<>;]*)$/,
    rewrite: (m) => `Get-ChildItem -Force ${m[1].trim()}`,
    description: "ls -a <path> → Get-ChildItem -Force <path>",
  },
  // `ls -a` / `ls -A` (no path).
  {
    pattern: /^ls\s+-[aA]$/,
    rewrite: () => "Get-ChildItem -Force",
    description: "ls -a → Get-ChildItem -Force",
  },
  // `ls -l <path>`.
  {
    pattern: /^ls\s+-l\s+([^-|<>;][^|<>;]*)$/,
    rewrite: (m) => `Get-ChildItem ${m[1].trim()}`,
    description: "ls -l <path> → Get-ChildItem <path>",
  },
  // `ls -l` (no path).
  {
    pattern: /^ls\s+-l$/,
    rewrite: () => "Get-ChildItem",
    description: "ls -l → Get-ChildItem",
  },
]

/**
 * Map a Unix-form command to its PowerShell equivalent on Windows.
 * Returns `{ command, originalCommand: null }` unchanged on Unix or
 * when no pattern matches. Otherwise the command is the rewritten
 * form and `originalCommand` carries the input verbatim.
 *
 * Pure — no I/O. The `platform` override is for tests.
 */
export function remapWindowsShellCommand(
  command: string,
  platform: NodeJS.Platform = process.platform,
): WindowsShellRemap {
  if (platform !== "win32") return { command, originalCommand: null }
  const trimmed = command.trim()
  for (const { pattern, rewrite } of UNIX_ALIAS_REMAPS) {
    const m = trimmed.match(pattern)
    if (m) return { command: rewrite(m), originalCommand: command }
  }
  return { command, originalCommand: null }
}

/**
 * Markers that identify a PowerShell cmdlet-binding / error-record
 * failure on stderr. These are PowerShell-specific class names and
 * field labels — tsc / eslint / npm / git / etc. do not happen to
 * emit them, so over-classification is unlikely.
 *
 * Conservative-by-design: the goal is to catch the canonical
 * Get-ChildItem-rejecting-`-la` shape and similar parameter-binding
 * failures. Anything that doesn't include one of these markers is
 * NOT treated as a PowerShell error.
 */
const POWERSHELL_ERROR_MARKERS: ReadonlyArray<string> = [
  "FullyQualifiedErrorId",
  "ParameterBindingException",
  "ParameterBindingValidationException",
  "NamedParameterNotFound",
  "MissingArgument",
  // PowerShell's standard ErrorRecord format always includes this
  // line. Combined with the markers above it's a strong signal.
  "+ CategoryInfo",
]

export interface PowerShellErrorDetection {
  /** True when stderr contains at least one PowerShell error marker. */
  isError: boolean
  /** The first marker that matched, or null. Useful for logging. */
  marker: string | null
}

/**
 * Scan a stderr string for PowerShell cmdlet-binding error markers.
 * Returns `{ isError: false, marker: null }` for empty input or
 * stderr that doesn't contain any marker.
 *
 * Pure — no I/O.
 */
export function detectPowerShellError(stderr: string): PowerShellErrorDetection {
  if (!stderr) return { isError: false, marker: null }
  for (const marker of POWERSHELL_ERROR_MARKERS) {
    if (stderr.includes(marker)) return { isError: true, marker }
  }
  return { isError: false, marker: null }
}
