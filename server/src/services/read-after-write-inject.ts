/**
 * Stage 3 of `2026-05-16-accountability-and-parallel-execution-sequencing.md`.
 *
 * After the agent's FIRST batch of `write_file` calls on a fresh
 * scaffold (project-init `repoState === "empty" | "small"`), inject
 * a `═══ READ-AFTER-WRITE REQUIRED ═══` block into the next prompt.
 * Forces the agent to read back what it just wrote BEFORE issuing
 * another write batch — closing the user-reported pattern where the
 * agent declared scaffold complete without verifying any of the
 * files actually contained what it intended.
 *
 * Latched per-run: fires AT MOST ONCE per run. Subsequent write
 * batches don't re-inject (the chunked-reasoning loop's reflector
 * covers ongoing verification; this stage targets the FIRST batch
 * specifically, where the import-sanitizer / escaping issues are
 * most common).
 *
 * Pure module — the latch is module-scoped state cleared at run
 * terminal-exit alongside the other per-run state.
 */

import type { ToolResult, BatchToolResult } from "../types.js"

/** Eligible repo states for the read-after-write inject. */
const ELIGIBLE_REPO_STATES = new Set<string>(["empty", "small"])

type LatchState = "pending" | "fired"

const _readAfterWriteLatch = new Map<string, LatchState>()

/**
 * Test-only — clear the entire store. Production code uses
 * `clearReadAfterWriteState(runId)` for run-level cleanup.
 */
export function _resetReadAfterWriteStoreForTests(): void {
  _readAfterWriteLatch.clear()
}

export function getReadAfterWriteLatchState(runId: string): LatchState | undefined {
  return _readAfterWriteLatch.get(runId)
}

export function markReadAfterWriteFired(runId: string): void {
  if (!runId) return
  _readAfterWriteLatch.set(runId, "fired")
}

export function clearReadAfterWriteState(runId: string): void {
  _readAfterWriteLatch.delete(runId)
}

/**
 * Pure: extract write_file paths from a single or batched tool
 * result. Only includes SUCCESSFUL writes — failed / skipped /
 * deferred writes shouldn't be in the read-back list.
 *
 * `batch_write` (the legacy fallback) also surfaces per-file
 * success status; we walk that too.
 */
export function extractSuccessfulWritePaths(
  single: ToolResult | undefined,
  batch: BatchToolResult[] | undefined,
): string[] {
  const out: string[] = []
  const consider = (tool: string, result: Record<string, unknown>): void => {
    if (tool === "write_file") {
      if (result.success === false || result.error) return
      const p = result.path
      if (typeof p === "string" && p.length > 0) out.push(p)
      return
    }
    if (tool === "batch_write") {
      const files = result.files
      if (Array.isArray(files)) {
        for (const f of files) {
          const entry = f as Record<string, unknown>
          if (entry.success === false || entry.error) continue
          const p = entry.path
          if (typeof p === "string" && p.length > 0) out.push(p)
        }
      }
    }
  }
  if (single) consider(single.tool, single.result as Record<string, unknown>)
  if (batch) for (const tr of batch) consider(tr.tool, tr.result as Record<string, unknown>)
  return out
}

export interface ShouldFireInputs {
  /** Run id — used for the per-run latch. */
  runId: string
  /** Project-init brief's repoState. Fires only for "empty" / "small". */
  repoState: string | null | undefined
  /** Paths the agent just successfully wrote in this turn. */
  writtenPaths: string[]
}

/**
 * Pure predicate: should the inject fire this turn?
 *
 * Gates:
 *   - latch state: only "pending" (not yet fired) → fires.
 *   - repoState ∈ {"empty","small"} → fires.
 *   - at least one successful write_file landed → fires.
 *
 * `runId` empty / missing → false (defensive).
 */
export function shouldFireReadAfterWriteInject(input: ShouldFireInputs): boolean {
  if (!input.runId) return false
  if (input.writtenPaths.length === 0) return false
  if (!input.repoState || !ELIGIBLE_REPO_STATES.has(input.repoState)) return false
  if (_readAfterWriteLatch.get(input.runId) === "fired") return false
  return true
}

/**
 * Build the inject block text. Lists the written paths so the agent
 * has a concrete checklist for batch_read. Lists are capped at
 * MAX_LIST_PATHS to keep the block bounded on very wide first
 * batches.
 */
const MAX_LIST_PATHS = 12

export function buildReadAfterWriteInject(writtenPaths: ReadonlyArray<string>): string {
  const total = writtenPaths.length
  const listed = writtenPaths.slice(0, MAX_LIST_PATHS)
  const remainder = total - listed.length
  const bullets = listed.map((p) => `  - ${p}`).join("\n")
  const remainderLine = remainder > 0 ? `\n  - ... and ${remainder} more file${remainder === 1 ? "" : "s"}` : ""
  return [
    "═══ READ-AFTER-WRITE REQUIRED ═══",
    "",
    `You just authored ${total} file${total === 1 ? "" : "s"} in this scaffold's first write batch:`,
    bullets + remainderLine,
    "",
    "Before proceeding to the next batch, READ each of these files back (use batch_read).",
    "Verify each file contains what you intended; the import-sanitizer or escaping may have",
    "altered your intent. If any file has wrong content, REWRITE it before continuing.",
    "",
    "Do NOT issue another write_file batch until you've completed this verification.",
    "",
    "═══ END READ-AFTER-WRITE REQUIRED ═══",
  ].join("\n")
}
