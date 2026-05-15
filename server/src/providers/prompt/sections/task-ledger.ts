/**
 * Stage 2 of free-tier quality enforcement plan: render the persistent
 * task ledger as a system-prompt section. Always-visible-when-non-empty
 * so the agent can't forget mid-run what subtasks remain.
 *
 * Non-cacheable — depends on the run's evolving ledger state.
 *
 * Sits at priority 103 in `build.ts`: AFTER env_info (100) +
 * investigation patterns (102), BEFORE reasoning_brief (107). That
 * places the "what remains" anchor close to the model's response
 * window so it sees the unfinished work last before deciding the next
 * action.
 */

import type { LedgerEntry } from "../../../services/task-ledger.js"

export interface TaskLedgerCtx {
  /** Snapshot of the run's ledger. Empty / undefined → section omitted. */
  taskLedger?: LedgerEntry[]
}

export function getTaskLedgerSection(ctx: TaskLedgerCtx): string | null {
  const entries = ctx.taskLedger ?? []
  if (entries.length === 0) return null

  const lines: string[] = []
  lines.push("═══ TASK LEDGER (what remains across the whole run) ═══")
  lines.push("")
  for (const entry of entries) {
    const checkbox = entry.status === "done"
      ? "[✓]"
      : entry.status === "in_progress"
      ? "[~]"
      : "[ ]"
    let line = `${checkbox} ${entry.label}`
    if (entry.deliverable) line += ` → ${entry.deliverable}`
    lines.push(line)
    // Surface evidence on the line below for items that landed — gives the
    // model file-path receipts so it knows what's already done.
    if (entry.status === "done" && entry.evidence && entry.evidence.length > 0) {
      const ev = entry.evidence.slice(0, 3).join(", ")
      const more = entry.evidence.length > 3 ? ` (+${entry.evidence.length - 3} more)` : ""
      lines.push(`      evidence: ${ev}${more}`)
    }
  }
  lines.push("")
  // Footer: a short directive tying the ledger to behaviour. Mild —
  // strong directives belong on the reasoning brief, not here. This is
  // just a reminder so the model doesn't drift away from the unfinished
  // subtasks.
  const pendingCount = entries.filter((e) => e.status === "pending").length
  const inProgressCount = entries.filter((e) => e.status === "in_progress").length
  if (pendingCount + inProgressCount > 0) {
    lines.push(`${pendingCount} pending · ${inProgressCount} in progress. Don't claim "completed" until every box is checked or you've surfaced WHY a box is being skipped.`)
  } else {
    lines.push("All ledger items are done — verify with the user before emitting completed.")
  }
  lines.push("═══")
  return lines.join("\n")
}
