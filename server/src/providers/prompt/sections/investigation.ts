/**
 * Stage 1 of command-first-investigation plan: concrete platform-aware
 * investigation patterns. Renders BELOW `tools.ts` + `task-guidelines.ts`
 * so the model has the abstract directive (investigate-first, reason
 * between commands) AND the concrete pattern library to draw from.
 *
 * Three pattern sub-blocks for the common task shapes (bug / implement-
 * unknown / explore) plus an explicit trivial-task short-circuit. The
 * pattern lists are platform-aware: bash forms on Unix, PowerShell forms
 * on Windows. The reasoner-backend-agnostic decision to render this
 * follows the same pattern as Stage C's DEEP_REASONING_PROMPT — pure
 * text that any backend interprets identically.
 *
 * Non-cacheable because it reads `ctx.platform`.
 */

export interface InvestigationCtx {
  /** From `EnvInfoCtx.platform` — informs which command examples render. */
  platform?: string
}

export function getInvestigationSection(ctx: InvestigationCtx = {}): string {
  const isWindows = (ctx.platform ?? process.platform) === "win32"

  const bugCmds = isWindows
    ? [
        "git log --oneline -10",
        "git status",
        'Select-String -Path "src\\**\\*.ts" -Pattern "<symptom>" -SimpleMatch',
        "Get-Content package.json | Select-Object -First 30",
      ]
    : [
        "git log --oneline -10",
        "git status",
        "grep -r '<symptom>' src/",
        "head -30 package.json",
      ]

  const implementCmds = isWindows
    ? [
        "Get-ChildItem -Force",
        "Get-Content package.json -ErrorAction SilentlyContinue",
        "git remote -v",
        'Get-ChildItem -Recurse -Filter "*.config.*" -ErrorAction SilentlyContinue | Select-Object -First 5',
      ]
    : [
        "ls -la",
        "cat package.json 2>/dev/null || true",
        "git remote -v",
        'find . -maxdepth 3 -name "*.config.*" 2>/dev/null | head -5',
      ]

  const exploreCmds = isWindows
    ? [
        "Get-ChildItem -Recurse -Filter \"*.ts\" -Depth 2 | Select-Object -First 20",
        'Select-String -Path "src\\**\\*" -Pattern "<topic>" -SimpleMatch | Select-Object -First 10',
        "Get-Content README.md -ErrorAction SilentlyContinue | Select-Object -First 40",
      ]
    : [
        'find . -maxdepth 3 -name "*.ts" 2>/dev/null | head -20',
        "grep -r '<topic>' src/ 2>/dev/null | head -10",
        "head -40 README.md 2>/dev/null || true",
      ]

  const lines: string[] = []
  lines.push("═══ INVESTIGATION PATTERNS ═══")
  lines.push("")
  lines.push("Concrete starting commands by task shape. Pick 2-4, reason about each output, then decide the next.")
  lines.push("")

  lines.push("BUG (something is broken / failing / errors):")
  for (const cmd of bugCmds) lines.push(`  $ ${cmd}`)
  lines.push("  → After these you'll know: what changed recently, what's modified, where the symptom appears.")
  lines.push("")

  lines.push("IMPLEMENT (building in an unfamiliar codebase):")
  for (const cmd of implementCmds) lines.push(`  $ ${cmd}`)
  lines.push("  → After these you'll know: the project shape, existing deps, the remote (Git origin), key config files.")
  lines.push("")

  lines.push("EXPLORE (mapping a topic / answering a 'how does X work?' question):")
  for (const cmd of exploreCmds) lines.push(`  $ ${cmd}`)
  lines.push("  → After these you'll have ≤3 candidate files to read_file. Don't read more — narrow first.")
  lines.push("")

  lines.push("TRIVIAL SHORT-CIRCUIT (user asks for a one-line change to a named file):")
  lines.push("  Skip investigation entirely. Reason in 1 brief paragraph about what the change is, then read_file and edit_file.")
  lines.push("  Example asks that warrant the short-circuit:")
  lines.push("    - \"fix the typo on line 12 of foo.ts\"")
  lines.push("    - \"add a console.log inside the handleClick function in App.tsx\"")
  lines.push("    - \"rename `oldName` to `newName` in lib/utils.ts\"")
  lines.push("  Do NOT manufacture a `git status` for these. Over-investigating wastes turns AND trains you to second-guess obvious moves.")
  lines.push("═══")
  return lines.join("\n")
}
