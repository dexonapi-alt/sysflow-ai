/**
 * Plan `2026-05-16-agent-code-correctness-and-completion-artifacts.md` Stage 2.
 *
 * Pure helpers for the import-sanitizer LOUD-feedback path. Extracted
 * from `tool-result.ts` so the inject contract is unit-testable
 * without a server harness.
 */

export interface StrippedFileEntry {
  path: string
  imports: string[]
}

/**
 * Scan a batch of tool results for `_strippedImports` arrays the cli
 * surfaced after import-sanitizer ran. Returns a flat list with each
 * file's stripped imports.
 *
 * Defensive: filters non-string entries; tolerates missing path /
 * missing _strippedImports without throwing. Pure.
 */
export function collectStrippedImports(
  results: Array<{ tool: string; result: Record<string, unknown> }>
): StrippedFileEntry[] {
  const out: StrippedFileEntry[] = []
  for (const tr of results) {
    const r = tr.result ?? {}
    const arr = (r as Record<string, unknown>)._strippedImports
    if (!Array.isArray(arr) || arr.length === 0) continue
    const path = typeof (r as Record<string, unknown>).path === "string"
      ? (r as Record<string, unknown>).path as string
      : "(unknown path)"
    const imports = arr.filter((s): s is string => typeof s === "string" && s.length > 0)
    if (imports.length === 0) continue
    out.push({ path, imports })
  }
  return out
}

/**
 * Render the `═══ IMPORTS STRIPPED ═══` block. Caps at 8 imports per
 * file in the rendered list (rest as `… and N more`) so a runaway
 * strip doesn't blow the prompt budget. Pure.
 */
export function buildImportStrippedInject(stripped: StrippedFileEntry[]): string {
  if (stripped.length === 0) return ""
  const totalCount = stripped.reduce((sum, s) => sum + s.imports.length, 0)
  const lines: string[] = []
  lines.push(`═══ IMPORTS STRIPPED — YOU REFERENCED FILES THAT DON'T EXIST ═══`)
  lines.push("")
  lines.push(`In ${stripped.length === 1 ? "the file" : `${stripped.length} files`} you just wrote, ${totalCount} import${totalCount === 1 ? "" : "s"} referenced files that don't exist on disk:`)
  lines.push("")
  for (const s of stripped) {
    lines.push(`  ${s.path}:`)
    for (const imp of s.imports.slice(0, 8)) {
      lines.push(`    - "${imp}" (file does not exist)`)
    }
    if (s.imports.length > 8) lines.push(`    … and ${s.imports.length - 8} more`)
  }
  lines.push("")
  lines.push("These imports were STRIPPED before writing to disk. The file you wrote no longer compiles correctly — it likely uses these names elsewhere without importing them.")
  lines.push("")
  lines.push("REQUIRED for your next turn:")
  lines.push("  1. Either CREATE the missing files in your next batch (preferred — those imports almost certainly represent real intent).")
  lines.push("  2. OR remove the usages of those names from the files above (rare — only if you meant something else).")
  lines.push("")
  lines.push("Do NOT proceed past this without addressing it. The agent-runtime-fixes plan's read-after-write step + the tsc gate will catch you if you forget.")
  lines.push("")
  lines.push("═══ END IMPORTS STRIPPED ═══")
  return lines.join("\n")
}
