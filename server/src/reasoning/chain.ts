/**
 * Phase 16 Stage 2: chained-reasoning helper.
 *
 * `runReasoning` (Phase 5) is a single-shot Flash call. Phase 16 introduces
 * cases where the same concern wants TWO calls in sequence — preflight gives
 * us an implement brief, then a chained `implement_elaborate` re-examines it
 * with fresh attention to "why this approach over alternatives, what
 * preconditions are assumed, re-scored confidence". Each stage's brief feeds
 * the next stage's payload.
 *
 * The same pattern serves Stage 4 (chained second-look divergence) and
 * Phase 18's pre-task confirmation. So the chain helper lives in its own
 * module rather than ad-hoc in any one handler.
 *
 * Design rules (intentional):
 *   - Pure orchestrator. Never throws into the caller.
 *   - Each stage's `buildPayload` is responsible for deciding whether to
 *     run. Returning `null` short-circuits that stage cleanly.
 *   - A throwing `runReasoning` call is logged + treated as a null brief;
 *     the chain continues with the prior stage's brief as input.
 *   - The audit log records every stage by name, even ones that returned
 *     null, so telemetry can distinguish "stage skipped" from "stage ran
 *     but returned null".
 *   - Telemetry note: each successful runReasoning increments
 *     usage-log's flashCallsCount via its own pathway. The chain helper
 *     does NOT add a counter. Per-call telemetry stays per-call.
 *
 * See `decisions.md: ## Planner ↔ reflector are additive, not merged` for
 * the broader rule: chain WITHIN a concern (e.g. preflight elaboration),
 * peer ACROSS concerns (planner / reflector / divergence stay independent).
 */

import { runReasoning, type ReasoningPayload } from "./task-reasoner.js"
import type { ReasoningBrief } from "./reasoning-schema.js"

/**
 * One stage in a reasoning chain. The `buildPayload` callback receives the
 * previous stage's brief (or null on the first stage / when prior was
 * null) plus the original chain payload, and returns either a fresh
 * payload to feed into `runReasoning` or null to skip this stage.
 *
 * The `name` is used in the audit log (helpful for debugging which
 * stage produced which brief).
 */
export interface ChainStage {
  /** Identifier for the stage. Surfaced in logs and the audit return. */
  name: string
  /**
   * Build the next stage's payload. Returning null skips this stage —
   * useful for stages that gate on prior confidence / brief content.
   *
   * `prior` is the most-recent non-null brief in the chain so far. If
   * every prior stage returned null, this is also null.
   */
  buildPayload(prior: ReasoningBrief | null, original: ReasoningPayload): ReasoningPayload | null
}

/** Per-stage outcome in chain order. `brief` is null when the stage was
 *  skipped (buildPayload returned null), the call threw, or runReasoning
 *  itself returned null (e.g. flag-disabled, cache miss + Flash failure). */
export interface ChainStageOutcome {
  name: string
  brief: ReasoningBrief | null
}

export interface ChainResult {
  /** The final stage's brief, or null when every stage skipped/failed. */
  finalBrief: ReasoningBrief | null
  /** Per-stage outcomes in the order the stages were declared. */
  stages: ChainStageOutcome[]
}

/**
 * Run a sequence of reasoning calls. Each stage receives the prior
 * stage's brief + the original payload; the chain returns the final
 * stage's brief plus a per-stage audit log.
 *
 * Empty stages → returns { finalBrief: null, stages: [] }.
 * Every stage skipped → finalBrief: null, audit shows the skips.
 *
 * Optional `runner` parameter is dependency-injected so tests can stub
 * `runReasoning` without monkey-patching the module. Defaults to the
 * production runReasoning.
 */
export async function runReasoningChain(
  original: ReasoningPayload,
  stages: ChainStage[],
  runner: (p: ReasoningPayload) => Promise<ReasoningBrief | null> = runReasoning,
): Promise<ChainResult> {
  const audit: ChainStageOutcome[] = []
  let prior: ReasoningBrief | null = null

  for (const stage of stages) {
    let nextPayload: ReasoningPayload | null = null
    try {
      nextPayload = stage.buildPayload(prior, original)
    } catch (err) {
      console.warn(`[reasoning-chain] stage '${stage.name}' buildPayload threw:`, (err as Error).message)
      nextPayload = null
    }
    if (!nextPayload) {
      audit.push({ name: stage.name, brief: null })
      continue
    }

    let brief: ReasoningBrief | null = null
    try {
      brief = await runner(nextPayload)
    } catch (err) {
      console.warn(`[reasoning-chain] stage '${stage.name}' runReasoning threw:`, (err as Error).message)
    }
    audit.push({ name: stage.name, brief })
    if (brief) prior = brief
  }

  return { finalBrief: prior, stages: audit }
}
