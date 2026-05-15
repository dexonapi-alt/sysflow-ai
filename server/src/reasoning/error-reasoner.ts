/**
 * Plan `2026-05-15-forced-error-reasoning-and-recovery.md` Stage 1+2.
 *
 * Iterative-paragraph error reasoner. When a tool errors,
 * `runErrorReasoningChain(payload, callBackend?)` fires the
 * `error_reasoning` pipeline (1-4 iterations, LLM owns the `done`
 * flag) and returns an `ErrorReasoningBrief` with:
 *
 *   - `paragraphs[]` — senior-engineer prose chain (surfaces in
 *     <ReasoningPeek> via PR #83's plain-prose render path)
 *   - `rootCause` — one-line hypothesis (e.g. *"Windows cmd.exe
 *     doesn't have ls"*)
 *   - `platformContext` — one phrase (e.g. *"win32 / cmd.exe"* or
 *     *"platform-independent"*)
 *   - `alternativeCommands[]` — 2-3 concrete commands to try
 *   - `recommendedCommand` — the single best next move
 *   - `confidence` + `iterations` + `committedVia` for telemetry
 *
 * Same self-directing-depth pattern as `classifyIntentByChain` —
 * shipped in PR #84 (intent classification). The orchestrator is
 * structurally near-identical; only the schema + the prompt differ.
 *
 * For Stage 1+2 (this PR), the chain is implemented + tested but NOT
 * yet wired into handlers. Stage 3 wires it into `tool-result.ts`'s
 * `on_error` path; the existing on_error bug pipeline stays as the
 * fallback when this chain returns null.
 */

import { z } from "zod"
import { callReasonerBackend } from "./backends/index.js"
import { pickReasonerBackend, type ReasonerBackend } from "../services/free-tier-policy.js"
import { getPipelineSystemPrompt } from "./pipelines/index.js"

/** Per-iteration shape the LLM emits. Mirrors
 *  `intentClassificationStepSchema` from PR #84 but with the
 *  error-specific fields the rubric asks for. */
export const errorReasoningStepSchema = z.object({
  paragraph: z.string().min(1).max(1200),
  done: z.boolean(),
  /** One-sentence root-cause hypothesis. Null on `done: false`. */
  rootCause: z.string().min(1).max(500).nullable(),
  /** Platform phrase (e.g. "win32 / cmd.exe"). Null on `done: false`. */
  platformContext: z.string().min(1).max(200).nullable(),
  /** 2-3 concrete alternative commands. Empty list permitted on `done: false`. */
  alternatives: z.array(z.string().min(1).max(500)).max(6).default([]),
  /** The single best next move. Null on `done: false`. */
  recommendedCommand: z.string().min(1).max(500).nullable(),
  confidence: z.enum(["HIGH", "MEDIUM", "LOW"]).nullable(),
  /** Index of a prior paragraph to REPLACE. Used to revise
   *  mid-chain instead of stacking contradictions. */
  supersedes: z.number().int().min(0).nullable().optional(),
})
export type ErrorReasoningStep = z.infer<typeof errorReasoningStepSchema>

/** Final brief returned by `runErrorReasoningChain`. The
 *  orchestrator flattens the iteration history into this shape so
 *  callers (Stage 3 wiring) don't need to walk the per-iteration
 *  outputs. */
export interface ErrorReasoningBrief {
  /** Senior-engineer paragraphs from the chain. */
  paragraphs: string[]
  rootCause: string
  platformContext: string
  alternativeCommands: string[]
  recommendedCommand: string
  confidence: "HIGH" | "MEDIUM" | "LOW"
  /** How many iterations actually fired (1-4). */
  iterations: number
  /** How the chain settled. `done_flag` = LLM committed via the
   *  flag; `step_cap` = ran to the cap without committing. */
  committedVia: "done_flag" | "step_cap"
}

/** Cap on the iterative chain. Errors are usually less ambiguous
 *  than intent classification (whose cap is 6); 4 is plenty. */
export const MAX_ERROR_REASONING_ITERATIONS = 4

/** Inputs the orchestrator needs. Kept narrow on purpose — callers
 *  pass the error context + platform info; the orchestrator handles
 *  backend selection + iteration management. */
export interface ErrorReasoningPayload {
  /** The verbatim error / stderr / exit message the tool returned. */
  errorText: string
  /** Tool that failed (e.g. `run_command`, `write_file`). */
  tool: string
  /** The args the tool was called with (e.g. `{ command: "ls -R" }`).
   *  Truncated when serialised so giant payloads don't blow the
   *  prompt budget. */
  args?: Record<string, unknown>
  /** Platform identifier (`process.platform` value). Surfaces in
   *  the user turn so the reasoner can spot platform-specific
   *  errors. */
  platform?: string
  /** Run's main-model identifier — fed to `pickReasonerBackend` so
   *  the error reasoner uses the same backend the preflight does. */
  model?: string | null
  /** Resolved value of `reasoning.backend` flag. */
  flagOverride?: string
  /** Per-iteration max output tokens. */
  maxOutputTokens?: number
  /** Hard ceiling on iterations. Defaults to
   *  {@link MAX_ERROR_REASONING_ITERATIONS}. */
  maxIterations?: number
  /** Optional: prior error-pattern memory recall (Stage 5). When
   *  set, surfaces in the user turn so the reasoner can confirm or
   *  revise the prior fix. */
  priorRecall?: string | null
}

/** Test-DI shape for the backend call. Production uses
 *  `callReasonerBackend` via `defaultLlmCall`; tests inject a stub
 *  that returns canned per-iteration JSON. */
export type ErrorReasoningLlmCall = (args: {
  backend: ReasonerBackend
  systemInstruction: string
  userTurn: string
  maxOutputTokens: number
}) => Promise<string>

/** Parse one iteration's raw JSON. Returns `null` on any malformed
 *  output so the orchestrator can stop the chain gracefully. */
export function parseErrorReasoningStep(raw: string): ErrorReasoningStep | null {
  // Strip common markdown fences the model might wrap the JSON in.
  const stripped = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim()
  try {
    const obj = JSON.parse(stripped) as Record<string, unknown>
    const parsed = errorReasoningStepSchema.safeParse(obj)
    if (!parsed.success) return null
    return parsed.data
  } catch {
    return null
  }
}

/** Build the user turn for one iteration. The system prompt covers
 *  the rubric; this turn carries the error + platform + prior
 *  paragraphs.
 *
 *  Pure — exported for tests + so the orchestrator stays readable. */
export function buildErrorReasoningUserTurn(payload: ErrorReasoningPayload, paragraphs: string[], stepIndex: number, maxSteps: number): string {
  const parts: string[] = []
  parts.push(`ITERATION ${stepIndex + 1} of up to ${maxSteps}`)
  parts.push("")
  parts.push(`TOOL: ${payload.tool}`)
  if (payload.args) {
    const argsJson = (() => {
      try { return JSON.stringify(payload.args).slice(0, 1500) }
      catch { return "(unserialisable)" }
    })()
    parts.push(`ARGS: ${argsJson}`)
  }
  parts.push(`PLATFORM: ${payload.platform ?? "unknown"}`)
  parts.push("")
  parts.push("ERROR (verbatim):")
  // Cap the error text. Long stacks get truncated to keep the
  // prompt under the model's effective attention window.
  parts.push(payload.errorText.slice(0, 4000))
  parts.push("")

  if (payload.priorRecall) {
    // Stage 5 of the plan: when error-pattern memory has a prior fix
    // for a similar error, surface it so the reasoner can confirm
    // or revise rather than starting from scratch.
    parts.push("PRIOR PATTERN MATCH (from .sysflow-memory.md):")
    parts.push(payload.priorRecall.slice(0, 1500))
    parts.push("")
  }

  if (paragraphs.length === 0) {
    parts.push("This is the FIRST iteration. Read the error carefully — every word matters, including the exact phrasing ('not recognized' vs 'not found' point at different root causes). Apply the senior-engineer rubric. If the failure is obvious after one pass, commit with `done: true`; if it could plausibly be more than one root cause, set `done: false` and end your paragraph with the specific question another iteration would answer.")
  } else {
    parts.push("PRIOR PARAGRAPHS (oldest first):")
    paragraphs.forEach((p, i) => parts.push(`[${i}] ${p}`))
    parts.push("")
    parts.push("This is a follow-up iteration. Address the question your prior paragraph raised. If a prior recommendation didn't fit (the agent's context invalidates it), use `supersedes: N` to revise that paragraph instead of stacking contradictions. Commit with `done: true` unless this pass surfaces another genuine question.")
  }
  parts.push("")
  parts.push("Output ONLY the JSON object. No markdown fences. No prose outside the JSON.")
  return parts.join("\n")
}

/**
 * LLM iterative paragraph chain for error reasoning. Self-directing
 * depth — the LLM marks `done: true` when ready to commit. Returns
 * `null` only when no usable hypothesis emerged (no reasoner backend
 * / every iteration unparseable / chain ran to cap with no
 * recommendation). The caller (Stage 3 wiring) treats `null` as
 * signal to fall back to the existing on_error bug pipeline.
 *
 * The `callBackend` parameter is for testing — defaults to
 * `callReasonerBackend` in production.
 */
export async function runErrorReasoningChain(
  payload: ErrorReasoningPayload,
  callBackend: ErrorReasoningLlmCall = defaultLlmCall,
): Promise<ErrorReasoningBrief | null> {
  // Resolve which backend to use. Same path the intent classifier +
  // preflight reasoner take.
  const backend = pickReasonerBackend({
    model: payload.model ?? null,
    flagOverride: payload.flagOverride ?? "auto",
  })
  if (!backend) return null  // No API keys → caller falls back to bug pipeline.

  const systemInstruction = getPipelineSystemPrompt("error_reasoning")
  const maxOutputTokens = payload.maxOutputTokens ?? 1200
  const maxIterations = Math.max(1, Math.min(payload.maxIterations ?? MAX_ERROR_REASONING_ITERATIONS, MAX_ERROR_REASONING_ITERATIONS))

  const paragraphs: string[] = []
  let lastRootCause: string | null = null
  let lastPlatformContext: string | null = null
  let lastAlternatives: string[] = []
  let lastRecommended: string | null = null
  let lastConfidence: "HIGH" | "MEDIUM" | "LOW" | null = null
  let committedViaDoneFlag = false
  let iterations = 0

  for (let i = 0; i < maxIterations; i++) {
    iterations = i + 1
    const userTurn = buildErrorReasoningUserTurn(payload, paragraphs, i, maxIterations)
    let raw: string
    try {
      raw = await callBackend({ backend, systemInstruction, userTurn, maxOutputTokens })
    } catch (err) {
      console.warn(`[error-reasoner] iteration ${iterations} failed: ${(err as Error).message}`)
      break
    }
    const step = parseErrorReasoningStep(raw)
    if (!step) {
      console.warn(`[error-reasoner] iteration ${iterations} unparseable; stopping with ${paragraphs.length} paragraph(s)`)
      break
    }

    // Anti-staleness: allow superseding a prior paragraph instead of
    // stacking contradictions.
    if (step.supersedes != null && step.supersedes >= 0 && step.supersedes < paragraphs.length) {
      paragraphs[step.supersedes] = step.paragraph
    } else {
      paragraphs.push(step.paragraph)
    }
    if (step.rootCause) lastRootCause = step.rootCause
    if (step.platformContext) lastPlatformContext = step.platformContext
    if (step.alternatives && step.alternatives.length > 0) lastAlternatives = step.alternatives
    if (step.recommendedCommand) lastRecommended = step.recommendedCommand
    if (step.confidence) lastConfidence = step.confidence

    if (step.done) {
      committedViaDoneFlag = true
      break
    }
  }

  // For an error reasoner to be useful the brief MUST have at least a
  // recommendedCommand. Without it the caller has nothing to surface
  // to the agent; the fallback (existing bug pipeline) is better.
  if (!lastRecommended) return null

  return {
    paragraphs,
    rootCause: lastRootCause ?? "(unknown — reasoner did not specify)",
    platformContext: lastPlatformContext ?? "unknown",
    alternativeCommands: lastAlternatives,
    recommendedCommand: lastRecommended,
    confidence: lastConfidence ?? "LOW",
    iterations,
    committedVia: committedViaDoneFlag ? "done_flag" : "step_cap",
  }
}

/** Production wiring: `callReasonerBackend` from the backend
 *  dispatcher. Kept as a default for `runErrorReasoningChain`'s
 *  `callBackend` parameter so tests can inject a stub. */
async function defaultLlmCall(args: { backend: ReasonerBackend; systemInstruction: string; userTurn: string; maxOutputTokens: number }): Promise<string> {
  return callReasonerBackend(args.backend, {
    payload: {
      trigger: "on_error",
      userMessage: args.userTurn,
      model: "error-reasoner",
    },
    kind: "error_reasoning",
    userTurnOverride: args.userTurn,
    defaultUserTurn: args.userTurn,
    maxOutputTokens: args.maxOutputTokens,
    systemInstruction: args.systemInstruction,
  })
}
