/**
 * Plan `2026-05-18-chunk-pulse-missing-diagnostic.md` Stage 2 — pure
 * helper that decides whether a server response should emit a
 * `chunk_plan` event for the Header's pulse cell.
 *
 * Pre-Stage-2 the decision was inlined at TWO sites in `agent.ts`
 * (initial-turn observer ~L581, per-turn observer ~L1788). Extracting
 * to a pure helper lets us:
 *
 *   - pin the contract with a single integration test (emit → reduce
 *     → render mode), so a regression in any of the three branches
 *     (a) emit / (b) reduce / (c) render is caught by one suite.
 *   - keep the agent.ts call sites symmetric — both extract the same
 *     fields, evaluate the same gate, and produce the same event
 *     payload.
 *
 * The helper is intentionally permissive on shape (`Record<string,
 * unknown>` in) so it handles both the typed `ClientResponse` and the
 * runtime-extended `{ chunkPlanBrief: ... }` shape the server attaches.
 * `nextAction` is required because the reducer's `chunk_plan` case
 * needs a non-empty label to render; the server's Zod schema enforces
 * `min(1)` so this should always be present on a validated brief, but
 * we defensively re-check at the cli boundary.
 */

export interface ChunkPlanBriefLike {
  nextAction?: string
  files?: string[]
}

/** The narrowed `chunk_plan` variant of `AgentEvent`. Returned in shape
 *  rather than via the union so call sites get exact `chunkIndex` /
 *  `fileCount` typing without a type-guard. */
export interface ChunkPlanEvent {
  type: "chunk_plan"
  chunkIndex: number
  nextAction: string
  fileCount: number
}

/**
 * Pure: build the `chunk_plan` event from a server response.
 *
 * Returns `null` when:
 *   - Ink is inactive (legacy mode — no Header to push the pulse into),
 *   - the response carries no `chunkPlanBrief`,
 *   - the brief's `nextAction` is missing / empty (defensive — the
 *     reducer's chunk slot needs a non-empty label).
 *
 * Otherwise returns a fully-formed `AgentEvent` ready for `emitAgent`.
 * Pure — no I/O, no state mutation.
 */
export function chunkPlanEventFromResponse(
  response: Record<string, unknown> | null | undefined,
  chunkIndex: number,
  inkActive: boolean,
): ChunkPlanEvent | null {
  if (!inkActive) return null
  if (!response) return null
  const brief = response.chunkPlanBrief as ChunkPlanBriefLike | undefined
  if (!brief || typeof brief.nextAction !== "string" || brief.nextAction.length === 0) return null
  return {
    type: "chunk_plan",
    chunkIndex,
    nextAction: brief.nextAction,
    fileCount: Array.isArray(brief.files) ? brief.files.length : 0,
  }
}
