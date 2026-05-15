/**
 * Stage 2 of free-tier quality enforcement plan: persistent task ledger.
 *
 * A high-level "what subtasks remain" anchor visible in the system
 * prompt EVERY turn so the agent can't forget mid-run. User feedback:
 * *"AI Agent LITERALLY FORGOT WHAT TO DO"*.
 *
 * Differs from existing structures:
 *   - **chunk plan** (Phase 10) is files for the NEXT chunk only
 *   - **taskPlan** (Phase 4) is whatever the AI emits in its envelope,
 *     visible only when present
 *   - **task ledger** (this module) is the FULL list of subtasks
 *     derived from the preflight implement brief's buildPlan, always
 *     present in the system prompt until the run finalizes
 *
 * Seeded from `implementBrief.buildPlan.steps` after preflight. Updated
 * after each chunk_reflect via the new `ledgerUpdates` field on the
 * reflection brief.
 *
 * In-memory per runId. Cleared on run finalize (same lifetime as
 * chunk-state). Pure module — exported helpers are testable without
 * spinning up a full reasoning loop.
 */

export type LedgerStatus = "pending" | "in_progress" | "done"

export interface LedgerEntry {
  /** Stable id for cross-turn updates. Generated from the step's index + slug. */
  id: string
  /** Human-readable label shown in the system prompt. From buildPlan.step. */
  label: string
  /** From buildPlan.deliverable — what concrete output completes this step. */
  deliverable?: string
  /** Current status. Starts pending. */
  status: LedgerStatus
  /** Optional file-path evidence the reflector cited when moving the status. */
  evidence?: string[]
}

export interface LedgerUpdate {
  id: string
  status: LedgerStatus
  evidence?: string[]
}

const ledgers = new Map<string, LedgerEntry[]>()

/**
 * Seed the ledger for a fresh run from the preflight implementBrief's
 * buildPlan. Replaces any prior ledger for the same runId (a /continue
 * with a fresh preflight rewrites the plan from zero).
 *
 * Accepts the buildPlan shape loosely (parsed externally — we just
 * read the fields we care about) so this module doesn't import the
 * reasoning-schema types and create a cycle.
 */
export function seedLedgerFromBuildPlan(
  runId: string,
  buildPlan: Array<{ step: string; deliverable?: string }>,
): void {
  if (!Array.isArray(buildPlan) || buildPlan.length === 0) {
    return
  }
  const entries: LedgerEntry[] = buildPlan
    .filter((s) => s && typeof s.step === "string" && s.step.trim().length > 0)
    .slice(0, 12)
    .map((s, i) => ({
      id: makeLedgerId(i, s.step),
      label: s.step.trim(),
      deliverable: typeof s.deliverable === "string" && s.deliverable.trim().length > 0
        ? s.deliverable.trim()
        : undefined,
      status: "pending" as LedgerStatus,
    }))
  if (entries.length === 0) return
  ledgers.set(runId, entries)
}

/**
 * Apply a batch of status updates produced by chunk_reflect. Unknown
 * ids are dropped (the reflector may hallucinate a synthetic id, but
 * we only honour ids we seeded). Invalid status values are dropped
 * too — the schema repair pass should have caught these but we're
 * defensive here.
 */
export function applyLedgerUpdates(runId: string, updates: LedgerUpdate[]): void {
  const entries = ledgers.get(runId)
  if (!entries || !Array.isArray(updates)) return

  for (const update of updates) {
    if (!update || typeof update.id !== "string") continue
    if (update.status !== "pending" && update.status !== "in_progress" && update.status !== "done") continue
    const idx = entries.findIndex((e) => e.id === update.id)
    if (idx === -1) {
      console.warn(`[task-ledger] update for unknown id "${update.id}" — dropping`)
      continue
    }
    entries[idx].status = update.status
    if (Array.isArray(update.evidence)) {
      const evidence = update.evidence
        .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
        .slice(0, 6)
      if (evidence.length > 0) entries[idx].evidence = evidence
    }
  }
}

/** Get a snapshot of the current ledger for a run. Returns [] if no ledger. */
export function getLedger(runId: string): LedgerEntry[] {
  const entries = ledgers.get(runId)
  if (!entries) return []
  // Return a defensive copy so callers can't mutate our internal state.
  return entries.map((e) => ({ ...e, evidence: e.evidence ? e.evidence.slice() : undefined }))
}

/** Clear the ledger for a run. Called from run finalize. */
export function clearLedger(runId: string): void {
  ledgers.delete(runId)
}

/** Test-only: reset all ledgers. */
export function _resetLedgersForTests(): void {
  ledgers.clear()
}

/**
 * Generate a stable id from an index + step text. Lowercase, hyphen-
 * separated, max 32 chars. Indexed so two steps with identical text
 * (rare but possible) get distinct ids.
 */
function makeLedgerId(index: number, step: string): string {
  const slug = step
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24)
  return `s${index}-${slug || "step"}`
}
