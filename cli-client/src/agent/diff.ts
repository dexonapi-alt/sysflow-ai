/**
 * Line-based diff engine — zero dependencies.
 *
 * Produces unified diff output with hunks, suitable for:
 * - Terminal display (color-coded +/- lines)
 * - Diff previews (collapsed/expanded)
 * - Patch storage for rollback
 *
 * Algorithm: Longest Common Subsequence (LCS) with O(ND) optimization
 * for typical code edits (small changes in large files).
 */

// ─── Types ───

export interface DiffLine {
  type: "context" | "add" | "remove"
  content: string
  oldLine?: number
  newLine?: number
}

export interface DiffHunk {
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  lines: DiffLine[]
}

export interface DiffResult {
  hunks: DiffHunk[]
  added: number
  removed: number
  changed: boolean
  /** Pre-formatted unified diff string */
  unified: string
}

// ─── Public API ───

/**
 * Compute a structured diff between old and new file content.
 * Returns hunks with context lines, add/remove counts, and a unified diff string.
 */
export function computeDiff(
  oldContent: string | null,
  newContent: string,
  contextLines: number = 3
): DiffResult {
  const oldLines = oldContent ? oldContent.split("\n") : []
  const newLines = newContent.split("\n")

  // Fast path: identical content
  if (oldContent === newContent) {
    return { hunks: [], added: 0, removed: 0, changed: false, unified: "" }
  }

  // Fast path: new file (no old content)
  if (!oldContent || oldLines.length === 0) {
    const lines: DiffLine[] = newLines.map((l, i) => ({
      type: "add" as const,
      content: l,
      newLine: i + 1
    }))
    const hunk: DiffHunk = {
      oldStart: 0, oldCount: 0,
      newStart: 1, newCount: newLines.length,
      lines
    }
    return {
      hunks: [hunk],
      added: newLines.length,
      removed: 0,
      changed: true,
      unified: formatUnified("(new file)", "", [hunk])
    }
  }

  // Compute LCS-based edit script
  const editScript = computeEditScript(oldLines, newLines)

  // Build hunks from edit script with context
  const hunks = buildHunks(editScript, oldLines, newLines, contextLines)

  let added = 0
  let removed = 0
  for (const h of hunks) {
    for (const l of h.lines) {
      if (l.type === "add") added++
      if (l.type === "remove") removed++
    }
  }

  return {
    hunks,
    added,
    removed,
    changed: hunks.length > 0,
    unified: formatUnified("a", "b", hunks)
  }
}

/**
 * Format a diff result as a colored terminal string.
 */
export function formatDiffColored(diff: DiffResult): string {
  if (!diff.changed) return "(no changes)"

  const lines: string[] = []
  for (const hunk of diff.hunks) {
    lines.push(`\x1b[36m@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@\x1b[0m`)
    for (const line of hunk.lines) {
      switch (line.type) {
        case "add":
          lines.push(`\x1b[32m+${line.content}\x1b[0m`)
          break
        case "remove":
          lines.push(`\x1b[31m-${line.content}\x1b[0m`)
          break
        case "context":
          lines.push(` ${line.content}`)
          break
      }
    }
  }
  return lines.join("\n")
}

/**
 * Simple summary: "+N -M" for compact display.
 */
export function formatDiffSummary(diff: DiffResult): { added: number; removed: number } {
  return { added: diff.added, removed: diff.removed }
}

// ─── Per-run diff store ───

interface StoredDiff {
  path: string
  diff: DiffResult
  oldContent: string | null
  newContent: string
  timestamp: number
}

const runDiffs = new Map<string, StoredDiff[]>()

export function storeDiff(runId: string, filePath: string, diff: DiffResult, oldContent: string | null, newContent: string): void {
  if (!runDiffs.has(runId)) {
    runDiffs.set(runId, [])
  }
  runDiffs.get(runId)!.push({
    path: filePath,
    diff,
    oldContent,
    newContent,
    timestamp: Date.now()
  })
}

export function getRunDiffs(runId: string): StoredDiff[] {
  return runDiffs.get(runId) || []
}

export function getLastDiff(runId: string): StoredDiff | null {
  const diffs = runDiffs.get(runId)
  if (!diffs || diffs.length === 0) return null
  return diffs[diffs.length - 1]
}

export function clearRunDiffs(runId: string): void {
  runDiffs.delete(runId)
}

// ─── Internal: LCS-based edit script ───

type EditOp = "keep" | "insert" | "delete"

interface EditEntry {
  op: EditOp
  oldIdx: number
  newIdx: number
  line: string
}

function computeEditScript(oldLines: string[], newLines: string[]): EditEntry[] {
  const m = oldLines.length
  const n = newLines.length

  // For very large files, use a faster approximation
  if (m + n > 10000) {
    return computeEditScriptFast(oldLines, newLines)
  }

  // Standard LCS via DP (O(mn) space, but fine for typical source files)
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1])
      }
    }
  }

  // Backtrack to build edit script
  const edits: EditEntry[] = []
  let i = m, j = n

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      edits.push({ op: "keep", oldIdx: i - 1, newIdx: j - 1, line: oldLines[i - 1] })
      i--
      j--
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      edits.push({ op: "insert", oldIdx: -1, newIdx: j - 1, line: newLines[j - 1] })
      j--
    } else {
      edits.push({ op: "delete", oldIdx: i - 1, newIdx: -1, line: oldLines[i - 1] })
      i--
    }
  }

  edits.reverse()
  return edits
}

/**
 * Fast edit script for large files — line-hash based.
 * Hashes lines, finds common prefix/suffix, only diffs the middle.
 */
function computeEditScriptFast(oldLines: string[], newLines: string[]): EditEntry[] {
  const edits: EditEntry[] = []

  // Common prefix
  let prefixLen = 0
  const maxPrefix = Math.min(oldLines.length, newLines.length)
  while (prefixLen < maxPrefix && oldLines[prefixLen] === newLines[prefixLen]) {
    edits.push({ op: "keep", oldIdx: prefixLen, newIdx: prefixLen, line: oldLines[prefixLen] })
    prefixLen++
  }

  // Common suffix
  let suffixLen = 0
  const maxSuffix = Math.min(oldLines.length - prefixLen, newLines.length - prefixLen)
  while (suffixLen < maxSuffix &&
    oldLines[oldLines.length - 1 - suffixLen] === newLines[newLines.length - 1 - suffixLen]) {
    suffixLen++
  }

  // Middle section: everything between prefix and suffix
  const oldMid = oldLines.slice(prefixLen, oldLines.length - suffixLen)
  const newMid = newLines.slice(prefixLen, newLines.length - suffixLen)

  // Simple approach for middle: remove all old, add all new
  // (For very large files, this is acceptable — the diff still shows what changed)
  for (let i = 0; i < oldMid.length; i++) {
    edits.push({ op: "delete", oldIdx: prefixLen + i, newIdx: -1, line: oldMid[i] })
  }
  for (let i = 0; i < newMid.length; i++) {
    edits.push({ op: "insert", oldIdx: -1, newIdx: prefixLen + i, line: newMid[i] })
  }

  // Suffix
  for (let i = 0; i < suffixLen; i++) {
    const oi = oldLines.length - suffixLen + i
    const ni = newLines.length - suffixLen + i
    edits.push({ op: "keep", oldIdx: oi, newIdx: ni, line: oldLines[oi] })
  }

  return edits
}

// ─── Internal: Build hunks from edit script ───

function buildHunks(edits: EditEntry[], oldLines: string[], newLines: string[], contextLines: number): DiffHunk[] {
  // Find ranges of changes (non-keep operations)
  const changeRanges: Array<{ start: number; end: number }> = []
  let inChange = false
  let changeStart = 0

  for (let i = 0; i < edits.length; i++) {
    if (edits[i].op !== "keep") {
      if (!inChange) {
        changeStart = i
        inChange = true
      }
    } else if (inChange) {
      changeRanges.push({ start: changeStart, end: i - 1 })
      inChange = false
    }
  }
  if (inChange) {
    changeRanges.push({ start: changeStart, end: edits.length - 1 })
  }

  if (changeRanges.length === 0) return []

  // Merge nearby ranges (within 2*contextLines of each other)
  const merged: Array<{ start: number; end: number }> = [changeRanges[0]]
  for (let i = 1; i < changeRanges.length; i++) {
    const prev = merged[merged.length - 1]
    if (changeRanges[i].start - prev.end <= contextLines * 2) {
      prev.end = changeRanges[i].end
    } else {
      merged.push(changeRanges[i])
    }
  }

  // Build hunks with context
  const hunks: DiffHunk[] = []

  for (const range of merged) {
    const ctxStart = Math.max(0, range.start - contextLines)
    const ctxEnd = Math.min(edits.length - 1, range.end + contextLines)

    const lines: DiffLine[] = []
    let oldLine = 0
    let newLine = 0

    // Count old/new line numbers up to ctxStart
    for (let i = 0; i < ctxStart; i++) {
      if (edits[i].op === "keep" || edits[i].op === "delete") oldLine++
      if (edits[i].op === "keep" || edits[i].op === "insert") newLine++
    }

    const oldStart = oldLine + 1
    const newStart = newLine + 1
    let oldCount = 0
    let newCount = 0

    for (let i = ctxStart; i <= ctxEnd; i++) {
      const edit = edits[i]
      switch (edit.op) {
        case "keep":
          oldLine++
          newLine++
          oldCount++
          newCount++
          lines.push({ type: "context", content: edit.line, oldLine, newLine })
          break
        case "delete":
          oldLine++
          oldCount++
          lines.push({ type: "remove", content: edit.line, oldLine })
          break
        case "insert":
          newLine++
          newCount++
          lines.push({ type: "add", content: edit.line, newLine })
          break
      }
    }

    hunks.push({ oldStart, oldCount, newStart, newCount, lines })
  }

  return hunks
}

// ─── Internal: Format unified diff ───

function formatUnified(oldName: string, newName: string, hunks: DiffHunk[]): string {
  if (hunks.length === 0) return ""

  const lines: string[] = []
  lines.push(`--- ${oldName}`)
  lines.push(`+++ ${newName}`)

  for (const hunk of hunks) {
    lines.push(`@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`)
    for (const line of hunk.lines) {
      switch (line.type) {
        case "add":
          lines.push(`+${line.content}`)
          break
        case "remove":
          lines.push(`-${line.content}`)
          break
        case "context":
          lines.push(` ${line.content}`)
          break
      }
    }
  }

  return lines.join("\n")
}
