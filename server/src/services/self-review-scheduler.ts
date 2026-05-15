/**
 * Stage 3 of free-tier quality enforcement plan: mandatory self-review
 * cadence tracker.
 *
 * Every N chunks of implementation, the system FORCES a self-review
 * turn — the agent must read back the recently-written files and
 * reason in `reasoningChain` about completeness BEFORE writing more.
 *
 * Closes user-reported failure mode: *"lacks checking every iteration"*
 * + *"wrong implementations because it lacks checking every iteration"*.
 * Without this, free models implement → implement → implement without
 * ever pausing to verify their own work landed coherently.
 *
 * Cadence:
 *   - Free-tier: review every 2 chunks (more failure-prone)
 *   - Paid: review every 4 chunks
 *
 * Per-run in-memory state. Cleared on run finalize via `clearReviewState`.
 * Pure helpers — no I/O.
 */

interface ReviewState {
  /** Index of the chunk after which a review was last forced. -1 if never. */
  lastReviewAtChunk: number
}

const reviewStates = new Map<string, ReviewState>()

export interface ShouldForceSelfReviewInput {
  /** Run id (per-run cadence tracking). */
  runId: string
  /** Current chunk index (0-based; chunk_reflect emits this). */
  chunkIndex: number
  /** Cadence from `getSelfReviewCadence(model)` — fire every N chunks. */
  cadence: number
  /** Resolved flag value for `quality.mandatory_self_review_enabled`. */
  flagEnabled: boolean
}

/**
 * Should the system inject a forced-review block into the next tool-
 * result? Returns true when ALL of these hold:
 *
 *   - Flag enabled
 *   - cadence is a positive integer
 *   - At least one chunk has actually executed (chunkIndex >= 0)
 *   - Enough chunks have happened since the last review
 *
 * Cadence trigger: a review fires when `chunkIndex - lastReviewAt >= cadence`.
 * For a fresh run (lastReviewAtChunk = -1) the first review fires when
 * `chunkIndex >= cadence - 1` (i.e. after chunk 1 for cadence 2, after chunk
 * 3 for cadence 4).
 *
 * Does NOT mark the review fired — the caller must call `markReviewFired`
 * after actually injecting. This split lets us test the decision logic
 * without mutating state.
 */
export function shouldForceSelfReview(input: ShouldForceSelfReviewInput): boolean {
  if (!input.flagEnabled) return false
  if (typeof input.cadence !== "number" || !Number.isFinite(input.cadence) || input.cadence <= 0) return false
  if (typeof input.chunkIndex !== "number" || !Number.isFinite(input.chunkIndex) || input.chunkIndex < 0) return false

  const last = getLastReviewIndex(input.runId)
  const elapsed = input.chunkIndex - last
  return elapsed >= input.cadence
}

/**
 * Record that a review block was injected for this chunk. Call AFTER
 * the injection lands so subsequent chunks don't re-fire until the
 * cadence elapses again.
 */
export function markReviewFired(runId: string, chunkIndex: number): void {
  if (typeof chunkIndex !== "number" || !Number.isFinite(chunkIndex) || chunkIndex < 0) return
  reviewStates.set(runId, { lastReviewAtChunk: chunkIndex })
}

/**
 * The chunk index after which a review was last forced. Returns -1 for
 * runs that have never had a forced review yet (so the first review
 * fires once `chunkIndex - (-1) === chunkIndex + 1 >= cadence`).
 */
export function getLastReviewIndex(runId: string): number {
  const state = reviewStates.get(runId)
  return state?.lastReviewAtChunk ?? -1
}

/** Clear per-run state on run finalize. */
export function clearReviewState(runId: string): void {
  reviewStates.delete(runId)
}

/** Test-only: reset all review state. */
export function _resetReviewStateForTests(): void {
  reviewStates.clear()
}

/**
 * Build the `═══ REVIEW REQUIRED ═══` directive block injected into the
 * next tool-result message when a forced review fires. Returns the
 * complete block including a closing line. Caller is responsible for
 * adding leading/trailing newlines.
 *
 * The block lists recently-written files (capped at 6) so the agent
 * knows exactly which paths to `batch_read`. When no files are
 * provided, the block falls back to a "list the files yourself"
 * directive.
 */
export function buildReviewBlock(input: {
  filesToReview: string[]
  chunkIndex: number
}): string {
  const files = (input.filesToReview ?? [])
    .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    .slice(0, 6)
  const lines: string[] = []
  lines.push("")
  lines.push("═══ REVIEW REQUIRED — read-back chunk before writing more ═══")
  lines.push("")
  lines.push(`The system requires a pause-and-verify turn after chunk ${input.chunkIndex}. Your last few chunks landed; before writing more, READ THEM BACK and reason about whether they actually fulfill the buildPlan.`)
  lines.push("")
  lines.push("This turn MUST be a review turn. Specifically:")
  lines.push("")
  if (files.length > 0) {
    lines.push(`1. \`batch_read\` these files in a single call:`)
    for (const file of files) {
      lines.push(`   - ${file}`)
    }
    lines.push("")
  } else {
    lines.push("1. `batch_read` the files you wrote in the last 1-2 chunks (consult the TASK LEDGER's evidence lines + the chunk history).")
    lines.push("")
  }
  lines.push("2. After the read returns, populate `reasoningChain` with mid-to-long paragraphs covering:")
  lines.push("   - Are the files COHERENT with each other (imports resolve, types align, names match)?")
  lines.push("   - Do they match the TASK LEDGER's deliverables, or did you drift?")
  lines.push("   - What's MISSING — any ledger item still pending that this chunk should have touched?")
  lines.push("   - Any CONTRADICTIONS with prior reasoning (a file's content disagrees with what you said you'd build)?")
  lines.push("")
  lines.push("3. DO NOT WRITE this turn. No `write_file` / `edit_file` / `batch_write` / `create_directory`.")
  lines.push("   If reading reveals something to fix, surface it in `reasoningChain` — the NEXT turn writes the fix.")
  lines.push("")
  lines.push("Skipping this review is a divergence signal. The system tracks it.")
  lines.push("═══ END REVIEW ═══")
  return lines.join("\n")
}
