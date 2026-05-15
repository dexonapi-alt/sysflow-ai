/**
 * Stage 1 of free-tier quality enforcement plan: pure helper that
 * generates a verify-after-write directive block. Injected by
 * `BaseProvider.buildToolResultMessage` into the next tool-result
 * message after any chunk that wrote files, so the agent SEES it
 * before deciding the next action.
 *
 * User feedback that drove this: *"free models create errors, typos,
 * forgot to implement in X folder (no files implemented), wrong
 * implementations because it lacks checking every iteration."*
 *
 * The block instructs the agent to:
 *   1. Read back what it just wrote (catches typos / wrong content)
 *   2. Check that any newly-created directory isn't empty (catches the
 *      "forgot to implement" failure mode at its source)
 *   3. Run typecheck if TS files were written
 *
 * Combined with the existing safe-command auto-approve allowlist
 * (Stage 2 of command-first-investigation), the suggested commands
 * pass without permission prompts so the agent can run them freely.
 *
 * Pure module — no I/O. Exported for unit tests.
 */

export interface VerifyAfterWriteInput {
  /** Absolute or project-relative file paths just written this turn. */
  filesWritten: string[]
  /** Directories created via create_directory this turn. */
  dirsCreated: string[]
  /** `process.platform` — informs bash vs PowerShell command form. */
  platform: string
}

/**
 * Build the verify-after-write directive block. Returns an empty string
 * when nothing was written/created (no-op insertion).
 *
 * Caps the per-block file count to keep the message short on chunks
 * that wrote many files. The model gets a "+N more" hint so it knows
 * to verify them too.
 */
export function buildVerifyAfterWriteBlock(input: VerifyAfterWriteInput): string {
  const files = (input.filesWritten ?? []).filter((s) => typeof s === "string" && s.trim().length > 0)
  const dirs = (input.dirsCreated ?? []).filter((s) => typeof s === "string" && s.trim().length > 0)
  if (files.length === 0 && dirs.length === 0) return ""

  const isWindows = input.platform === "win32"
  const lines: string[] = []
  lines.push("")
  lines.push("═══ VERIFY THE LAST CHUNK (run these BEFORE writing anything else) ═══")
  lines.push("")
  lines.push("You just wrote files. Confirm they landed correctly before continuing — free-model runs commonly land typos, empty folders, or wrong content without noticing.")
  lines.push("")

  // 1. Read back what we just wrote.
  if (files.length > 0) {
    lines.push("Read back what you wrote:")
    const limited = files.slice(0, 4)
    for (const file of limited) {
      lines.push(`  ${isWindows ? "Get-Content" : "cat"} ${file}`)
    }
    if (files.length > 4) {
      lines.push(`  ... + ${files.length - 4} more file(s) you wrote — verify those too if any look critical`)
    }
    lines.push("")
  }

  // 2. Empty-folder check — the most common silent failure on free models.
  if (dirs.length > 0) {
    lines.push("Verify created directories aren't empty (the most common silent failure):")
    const limitedDirs = dirs.slice(0, 3)
    for (const dir of limitedDirs) {
      if (isWindows) {
        lines.push(`  Get-ChildItem -Recurse ${dir}`)
      } else {
        lines.push(`  find ${dir} -type f`)
      }
    }
    if (dirs.length > 3) {
      lines.push(`  ... + ${dirs.length - 3} more directory(ies)`)
    }
    lines.push("")
  }

  // 3. Typecheck if any TS file was written.
  const hasTs = files.some((f) => /\.(ts|tsx)$/i.test(f))
  const hasJs = files.some((f) => /\.(js|jsx|mjs|cjs)$/i.test(f))
  if (hasTs) {
    lines.push("TypeScript files written — confirm types still compile:")
    lines.push(`  npm run typecheck`)
    lines.push("")
  } else if (hasJs) {
    lines.push("JavaScript files written — confirm there's no obvious syntax error:")
    lines.push(`  node --check <one of the files you wrote>`)
    lines.push("")
  }

  // 4. Closing directive — agent must reason about results before next write.
  lines.push("After running these checks, reason in `reasoningChain` about what they revealed:")
  lines.push("  - Did the content match what you intended? Any typos visible in the read-back?")
  lines.push("  - Are the directories you created populated, or did you leave one empty?")
  lines.push("  - Did typecheck/syntax-check pass? If not, FIX before continuing.")
  lines.push("")
  lines.push("If anything failed, fix it FIRST. Only then proceed to the next chunk.")
  lines.push("═══ END VERIFY ═══")
  return lines.join("\n")
}

/**
 * Extract `filesWritten` + `dirsCreated` from a list of tool results
 * (the shape `BaseProvider.buildToolResultMessage` already has in its
 * `tools` local). Pure derivation — no I/O.
 *
 * Recognises:
 *   - `write_file`, `edit_file`, `batch_write` → file written
 *   - `create_directory` → directory created
 *
 * Failed tool calls (those whose result has `success: false` or `error`)
 * are skipped — we only verify successful writes.
 */
export interface VerifierExtractInput {
  tools: Array<{ tool: string; result: Record<string, unknown> }>
}

export function extractWritesFromToolResults(input: VerifierExtractInput): { filesWritten: string[]; dirsCreated: string[] } {
  const filesWritten: string[] = []
  const dirsCreated: string[] = []

  for (const tc of input.tools ?? []) {
    if (!tc || typeof tc.tool !== "string") continue
    const result = tc.result ?? {}
    // Skip failed writes — no point asking the agent to cat a file that didn't write.
    if ((result as Record<string, unknown>).success === false) continue
    if (typeof (result as Record<string, unknown>).error === "string") continue

    const path = typeof (result as Record<string, unknown>).path === "string"
      ? ((result as Record<string, unknown>).path as string)
      : ""
    const paths = Array.isArray((result as Record<string, unknown>).paths)
      ? ((result as Record<string, unknown>).paths as unknown[]).filter((p): p is string => typeof p === "string" && p.trim().length > 0)
      : []

    if (tc.tool === "write_file" || tc.tool === "edit_file") {
      if (path) filesWritten.push(path)
    } else if (tc.tool === "batch_write") {
      for (const p of paths) filesWritten.push(p)
    } else if (tc.tool === "create_directory") {
      if (path) dirsCreated.push(path)
    }
  }

  // De-dupe (a single chunk might write the same file via multiple ops; the
  // agent only needs one cat).
  return {
    filesWritten: Array.from(new Set(filesWritten)),
    dirsCreated: Array.from(new Set(dirsCreated)),
  }
}
