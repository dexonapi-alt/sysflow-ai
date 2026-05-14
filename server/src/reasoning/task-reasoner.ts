/**
 * Reasoning orchestrator. One entry point — runReasoning() — that:
 *   1. Picks the pipeline (uses intent classifier for preflight; trigger-
 *      driven for self_invoked / on_error / on_completion).
 *   2. Checks the cache; returns immediately on hit.
 *   3. Calls Gemini with the pipeline-specific system prompt + a short
 *      user-turn carrying the task context.
 *   4. Parses + validates with Zod; runs the critical-context detector;
 *      caches the result; returns the brief or null.
 *
 * Recursion guard: a self_invoked call from inside a self_invoked call is
 * rejected immediately. The reasoning model never calls tools.
 */

import crypto from "node:crypto"
import { GoogleGenerativeAI } from "@google/generative-ai"
import { classifyIntent, type IntentHint } from "./intent-classifier.js"
import { reasoningEnvelopeSchema, assertEnvelopeShape, type ReasoningBrief, type ReasoningTrigger } from "./reasoning-schema.js"
import { getReasoningCache, setReasoningCache } from "./reasoning-cache.js"
import { applyCriticalContextDetector } from "./critical-context-detector.js"
import { repairReasoningResponse } from "./repair.js"
import { getPipelineSystemPrompt, type PipelineKind } from "./pipelines/index.js"
import { getFlag } from "../services/flags.js"
import { shouldRunIterativeRefine } from "../services/free-tier-policy.js"
import { analyzeTaskComplexity } from "../services/completion-guard.js"

/**
 * Hard timeout on a single reasoner SDK call. The Google SDK does its own
 * exponential backoff on 5xx / network errors with no externally-settable
 * cap, which means a sustained 4xx (e.g. an IP-blocked key) can hold the
 * whole agent for minutes silently. 30s is well past any healthy Flash
 * response time and well short of "the user gives up".
 */
const REASONER_TIMEOUT_MS = 30_000

export interface ReasoningPayload {
  trigger: ReasoningTrigger
  /** The user's prompt (preflight) or the agent's question (self_invoked) or the symptom (on_error) or the run summary (on_completion). */
  userMessage: string
  model: string
  cwd?: string | null
  /** Optional structured context appended to the user-turn for the reasoner. */
  context?: Record<string, unknown>
  /** Project memory mtime (for cache invalidation). */
  projectMemoryMtime?: number
  sysbasePath?: string | null
}

const inFlightSelfInvoked = new Set<string>()

export async function runReasoning(payload: ReasoningPayload): Promise<ReasoningBrief | null> {
  // Trigger-level kill switch.
  // Phase 10: both chunk triggers share one flag (reasoning.chunked_loop_enabled)
  // because they're a unit — there's no useful state where the planner runs
  // without the reflector or vice versa.
  // Phase 11: divergence_check is gated by `awareness.enabled` — same flag
  // that gates the heuristic detector + verification gate.
  // Phase 16 Stage 3: implement_elaborate has its own flag so the
  // chained call can be disabled without affecting the preflight that
  // precedes it.
  const flagName = (payload.trigger === "chunk_plan" || payload.trigger === "chunk_reflect")
    ? "reasoning.chunked_loop_enabled"
    : payload.trigger === "divergence_check"
    ? "awareness.enabled"
    : payload.trigger === "implement_elaborate"
    ? "reasoning.chained.preflight_elaboration_enabled"
    : (`prompt.${payload.trigger}_reasoning_enabled` as const)
  try {
    if (!getFlag<boolean>(flagName, payload.sysbasePath)) return null
  } catch {
    // Flag not registered (e.g., tests) — proceed.
  }

  // Recursion guard for self-invoked.
  if (payload.trigger === "self_invoked") {
    const guardKey = `${payload.cwd ?? ""}::${payload.userMessage}`
    if (inFlightSelfInvoked.has(guardKey)) {
      console.warn(`[reasoning] self_invoked recursion guard tripped`)
      return null
    }
    inFlightSelfInvoked.add(guardKey)
    try {
      return await runReasoningInner(payload)
    } finally {
      inFlightSelfInvoked.delete(guardKey)
    }
  }

  return runReasoningInner(payload)
}

async function runReasoningInner(payload: ReasoningPayload): Promise<ReasoningBrief | null> {
  // Pipeline selection.
  const kind = pickPipeline(payload)
  if (kind === "simple") {
    // No reasoning needed — return a stub envelope so callers can short-circuit uniformly.
    return {
      pipeline: "simple",
      confidence: "HIGH",
      decision: "proceed",
      missingContext: [],
      reasoningTrace: "intent classifier returned simple — no reasoning call",
      reasoningChain: [],
    }
  }

  // Cache lookup.
  // Phase 10: hash the FULL context (not slice(0, 2000)) so chunk_plan and
  // chunk_reflect calls with long histories don't collide in the cache when
  // their prefixes happen to match.
  const cacheKey = {
    trigger: payload.trigger,
    userMessage: payload.userMessage,
    cwd: payload.cwd ?? "",
    model: payload.model,
    projectMemoryMtime: payload.projectMemoryMtime ?? 0,
    errorContext: payload.context ? hashContext(payload.context) : "",
  }
  const cached = getReasoningCache(cacheKey)
  if (cached) {
    console.log(`[reasoning] cache hit trigger=${payload.trigger} pipeline=${cached.pipeline}`)
    return cached
  }

  // Model call. Guarded with a hard timeout so a stuck SDK retry can't
  // hold the whole agent flow — `runReasoningInner` returns null on
  // timeout and the handler keeps going in legacy / no-brief mode.
  let raw: string
  try {
    raw = await callReasonerWithTimeout(payload, kind)
  } catch (err) {
    console.warn(`[reasoning] model call failed: ${(err as Error).message}`)
    return null
  }

  // Stage C of model-lock-and-portable-reasoning: iterative refine pass.
  // A second reasoner invocation takes the first draft as input, finds
  // 2-3 weaknesses in the reasoningChain, and produces a revised
  // envelope. The revised raw replaces the draft for parsing; if the
  // refine call fails (network / timeout) we fall back to the draft.
  // Gate via `shouldRunIterativeRefine` — skips summary /
  // implement_elaborate / divergence (see free-tier-policy.ts for why).
  const refineEnabled = (() => {
    try { return getFlag<boolean>("reasoning.iterative_refine_enabled", payload.sysbasePath) } catch { return true }
  })()
  // Stage C: complexity-aware gating. `analyzeTaskComplexity` is a cheap pure
  // helper (keyword + length heuristics) — running it inline costs nothing
  // and gives us a "skip refine on trivial work" signal. User feedback was
  // explicit: *"when super easy task and so obvious it doesnt need to reason
  // deeply"*. The system-level skip complements the prompt-level "be smart
  // about depth" instruction in `DEEP_REASONING_PROMPT`.
  const complexity = analyzeTaskComplexity(payload.userMessage).complexity
  if (shouldRunIterativeRefine({ kind, model: payload.model, flagEnabled: refineEnabled, complexity })) {
    try {
      const refinedRaw = await callReasonerWithTimeout(payload, kind, buildCritiqueUserTurn(payload, kind, raw))
      // Sanity check: refined output must at least be non-empty JSON-ish.
      // If parsing fails downstream, we'll fall back to the draft.
      raw = refinedRaw || raw
      console.log(`[reasoning] iterative refine pass complete for trigger=${payload.trigger} pipeline=${kind}`)
    } catch (err) {
      console.warn(`[reasoning] iterative refine failed, keeping draft: ${(err as Error).message}`)
    }
  }

  // Parse + validate. The repair pass runs BEFORE Zod validation and
  // coerces common Flash quirks (empty `recommendedStack.language`, null
  // arrays, missing `reasoningTrace`) into placeholder-but-valid shapes
  // so the brief isn't dropped over a single field. Genuinely malformed
  // responses (no JSON, wrong pipeline) still return null.
  let parsed: ReasoningBrief
  try {
    const json = stripFences(raw)
    const obj = JSON.parse(json)
    const repaired = repairReasoningResponse(obj)
    parsed = reasoningEnvelopeSchema.parse(repaired)
    parsed = assertEnvelopeShape(parsed)
  } catch (err) {
    console.warn(`[reasoning] parse/validate failed: ${(err as Error).message}; falling back to no-brief`)
    return null
  }

  // Cross-check + cache.
  const refined = applyCriticalContextDetector(parsed, payload.userMessage)
  setReasoningCache(cacheKey, refined)
  return refined
}

function pickPipeline(payload: ReasoningPayload): PipelineKind | "simple" {
  if (payload.trigger === "self_invoked") return "decision"
  if (payload.trigger === "on_error") return "bug"
  if (payload.trigger === "on_completion") return "summary"
  // Phase 10: chunked-loop triggers route directly. No intent classifier
  // because chunk_plan / chunk_reflect are always invoked from inside an
  // active agent loop where the pipeline is already known.
  if (payload.trigger === "chunk_plan") return "chunk_plan"
  if (payload.trigger === "chunk_reflect") return "chunk_reflect"
  // Phase 11: divergence_check is invoked from the awareness path with the
  // pipeline already resolved.
  if (payload.trigger === "divergence_check") return "divergence"
  // Phase 16 Stage 3: chained second-stage Flash on top of preflight's
  // implement brief. Trigger always maps to the elaboration pipeline —
  // the gate that decides whether to fire it lives upstream in
  // free-tier-policy.ts: shouldRunPreflightElaboration.
  if (payload.trigger === "implement_elaborate") return "implement_elaborate"
  // preflight: defer to intent classifier.
  const hint: IntentHint = classifyIntent(payload.userMessage)
  return hint
}

/**
 * Guard `callReasoner` with a hard timeout. The Google SDK does its own
 * exponential backoff internally with no externally-settable cap, so a
 * sustained 4xx (IP-blocked key, region restriction, etc.) can hold the
 * whole agent for minutes silently. The race below loses to a 30s
 * timeout — the caller then logs and returns null, and the handler
 * continues in legacy / no-brief mode.
 *
 * The `setTimeout` is `unref`'d so it doesn't keep the process alive
 * past graceful shutdown, and cleared on the success path so test runs
 * don't leak handles between cases.
 */
async function callReasonerWithTimeout(payload: ReasoningPayload, kind: PipelineKind, userTurnOverride?: string): Promise<string> {
  let timer: NodeJS.Timeout | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`reasoner timed out after ${REASONER_TIMEOUT_MS}ms`)),
      REASONER_TIMEOUT_MS,
    )
    timer.unref?.()
  })
  try {
    return await Promise.race([callReasoner(payload, kind, userTurnOverride), timeoutPromise])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function callReasoner(payload: ReasoningPayload, kind: PipelineKind, userTurnOverride?: string): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set")
  const genAI = new GoogleGenerativeAI(apiKey)

  const maxOutputTokens = (() => {
    try { return getFlag<number>("reasoning.max_output_tokens", payload.sysbasePath) } catch { return 2_500 }
  })()

  // Always run reasoning on Gemini Flash regardless of the main model — cheap + fast.
  // (Stage D of model-lock-and-portable-reasoning will replace this with a pluggable
  // backend dispatcher; Stage C keeps Gemini Flash so the iterative-refine wiring
  // can land in isolation.)
  const reasonerModelName = "gemini-2.5-flash"
  const model = genAI.getGenerativeModel({
    model: reasonerModelName,
    systemInstruction: getPipelineSystemPrompt(kind),
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0.0,
      maxOutputTokens,
    },
  })

  // Stage C: `userTurnOverride` lets the iterative-refine pass send a
  // critique-and-revise user turn instead of the standard initial one.
  // First-pass calls leave it undefined and get `buildUserTurn`.
  const userTurn = userTurnOverride ?? buildUserTurn(payload, kind)
  const result = await model.generateContent(userTurn)
  return result.response.text()
}

function buildUserTurn(payload: ReasoningPayload, kind: PipelineKind): string {
  const parts: string[] = []
  parts.push(`PIPELINE: ${kind}`)
  parts.push(`TRIGGER: ${payload.trigger}`)
  if (payload.cwd) parts.push(`CWD: ${payload.cwd}`)
  parts.push("")
  parts.push("USER PROMPT:")
  parts.push(payload.userMessage)
  if (payload.context && Object.keys(payload.context).length > 0) {
    parts.push("")
    parts.push("CONTEXT:")
    parts.push(JSON.stringify(payload.context).slice(0, 4000))
  }
  parts.push("")
  parts.push("Output ONLY the JSON envelope. Nothing else.")
  return parts.join("\n")
}

/**
 * Stage C of model-lock-and-portable-reasoning: build the user turn for
 * the iterative-refine second pass. The reasoner sees its own first
 * draft and a critique-and-revise instruction. The revised envelope
 * replaces the draft before Zod validation downstream.
 *
 * Truncates the draft to ~6KB so the critique turn stays well under the
 * reasoner's context budget even on the longest preflight briefs.
 */
function buildCritiqueUserTurn(payload: ReasoningPayload, kind: PipelineKind, draftRaw: string): string {
  const parts: string[] = []
  parts.push(`PIPELINE: ${kind}`)
  parts.push(`TRIGGER: ${payload.trigger} (refinement pass)`)
  if (payload.cwd) parts.push(`CWD: ${payload.cwd}`)
  parts.push("")
  parts.push("USER PROMPT:")
  parts.push(payload.userMessage)
  if (payload.context && Object.keys(payload.context).length > 0) {
    parts.push("")
    parts.push("CONTEXT:")
    parts.push(JSON.stringify(payload.context).slice(0, 3500))
  }
  parts.push("")
  parts.push("YOUR FIRST DRAFT (the envelope you produced on the first pass):")
  parts.push(draftRaw.slice(0, 6000))
  parts.push("")
  parts.push("CRITIQUE AND REVISE.")
  parts.push("1. Find 2-3 specific weaknesses in your `reasoningChain`. Look for: shallow steps, missed alternatives, unstated assumptions, weak self-critique, root causes you stopped chasing too early.")
  parts.push("2. Strengthen those steps. Add a paragraph where the chain was thin. Rewrite paragraphs that were generic.")
  parts.push("3. Update structured fields IF the deeper thinking changes them (e.g. you realised an alternative is actually better).")
  parts.push("4. Output the REVISED full envelope. Same schema, same pipeline. Same JSON shape — just better content.")
  parts.push("")
  parts.push("Output ONLY the revised JSON envelope. Nothing else.")
  return parts.join("\n")
}

function stripFences(s: string): string {
  const trimmed = s.trim()
  if (trimmed.startsWith("```")) {
    return trimmed.replace(/^```(?:json)?\s*/, "").replace(/```\s*$/, "")
  }
  return trimmed
}

/**
 * Stable sha256 hash of the FULL serialised context. Used in the reasoning
 * cache key so two distinct chunk-plan/reflect contexts can never collide,
 * regardless of how long the chunk history grows. Truncating to a fixed
 * prefix (the previous strategy) caused aliasing once contexts shared the
 * first ~2KB.
 */
export function hashContext(ctx: unknown): string {
  const serialised = JSON.stringify(ctx) ?? ""
  // Use the same algorithm as buildCacheKey for consistency. Hex digest.
  // node:crypto's sha256 over a few KB is sub-millisecond.
  return crypto.createHash("sha256").update(serialised).digest("hex")
}
