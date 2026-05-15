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
import { classifyIntent, getCachedIntentOrRegex, type IntentHint } from "./intent-classifier.js"
import { reasoningEnvelopeSchema, assertEnvelopeShape, type ReasoningBrief, type ReasoningTrigger } from "./reasoning-schema.js"
import { getReasoningCache, setReasoningCache } from "./reasoning-cache.js"
import { applyCriticalContextDetector } from "./critical-context-detector.js"
import { repairReasoningResponse } from "./repair.js"
import { getPipelineSystemPrompt, type PipelineKind } from "./pipelines/index.js"
import { getFlag } from "../services/flags.js"
import { shouldRunIterativeRefine, shouldRunIterativeChain, pickReasonerBackend, type ReasonerBackend } from "../services/free-tier-policy.js"
import { analyzeTaskComplexity } from "../services/completion-guard.js"
import { callReasonerBackend } from "./backends/index.js"

/**
 * Stage E of model-lock-and-portable-reasoning: per-run telemetry of
 * which reasoner backend served the run. Populated by `callReasoner`
 * on each successful pick; read by the user-message / tool-result
 * handlers and surfaced on `ClientResponse.reasonerBackend` so the CLI
 * can record it in `RunSummary`.
 *
 * The backend is constant for the duration of a run (env doesn't shift
 * mid-run), so this map is logically write-once-per-run. Re-writes are
 * harmless — the value is the same. Cleared by `clearReasonerBackendForRun`
 * from the terminal-cleanup path alongside the other per-run state
 * stores (`clearConfidence`, `clearLedger`, `clearLastReasoning`, ...).
 */
const reasonerBackendByRun = new Map<string, ReasonerBackend>()

export function getReasonerBackendForRun(runId: string): ReasonerBackend | null {
  return reasonerBackendByRun.get(runId) ?? null
}

export function clearReasonerBackendForRun(runId: string): void {
  reasonerBackendByRun.delete(runId)
}

/** Test-only helper. */
export function _resetReasonerBackendForTests(): void {
  reasonerBackendByRun.clear()
}

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
  /**
   * Stage E of model-lock-and-portable-reasoning: when set, the
   * resolved reasoner backend is recorded against this runId so the
   * response builder can surface `ClientResponse.reasonerBackend` for
   * CLI telemetry. Optional — callers that don't care (e.g. the
   * standalone `/reason` route) can omit it.
   */
  runId?: string
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

  // Pre-compute task complexity once — both gates below consult it, and
  // the helper is a cheap pure function (keyword + length heuristics).
  const complexity = analyzeTaskComplexity(payload.userMessage).complexity

  // Iterative paragraph chain mode (paragraph-by-paragraph reasoning).
  // User feedback after seeing Stage C's bulk THINKING block: *"reason it
  // one by one → call llm → reason 2nd → reason 3rd time → repeat until
  // done"*. When this mode is on, the reasoner produces the chain ACROSS
  // N Flash calls (one paragraph per call, each seeing prior paragraphs
  // + allowed to revise/supersede them). Then one final synthesis call
  // produces the structured brief fields. Replaces the single-shot path
  // — these are alternative deliveries of the same envelope shape.
  const iterativeChainEnabled = (() => {
    try { return getFlag<boolean>("reasoning.iterative_paragraph_chain_enabled", payload.sysbasePath) } catch { return true }
  })()

  let raw: string
  // When iterative chain mode runs successfully, we keep the assembled
  // chain here and override it onto the parsed envelope post-validation.
  // Defensive against the synthesis call dropping or rewriting paragraphs.
  let assembledChain: string[] | null = null
  if (shouldRunIterativeChain({ kind, model: payload.model, flagEnabled: iterativeChainEnabled, complexity })) {
    try {
      const chain = await runIterativeChain(payload, kind)
      if (chain.length === 0) {
        // No paragraphs produced — fall through to legacy one-shot.
        console.warn(`[reasoning] iterative chain produced zero paragraphs, falling back to one-shot`)
        raw = await callReasonerWithTimeout(payload, kind)
      } else {
        console.log(`[reasoning] iterative chain assembled ${chain.length} paragraph(s) for trigger=${payload.trigger} pipeline=${kind}`)
        assembledChain = chain
        raw = await synthesizeStructuredBrief(payload, kind, chain)
      }
    } catch (err) {
      console.warn(`[reasoning] iterative chain failed (${(err as Error).message}); falling back to one-shot`)
      try {
        raw = await callReasonerWithTimeout(payload, kind)
      } catch (err2) {
        console.warn(`[reasoning] one-shot fallback also failed: ${(err2 as Error).message}`)
        return null
      }
    }
  } else {
    // Legacy one-shot Flash call. Guarded with a hard timeout so a stuck
    // SDK retry can't hold the whole agent flow — `runReasoningInner`
    // returns null on timeout and the handler keeps going in legacy /
    // no-brief mode.
    try {
      raw = await callReasonerWithTimeout(payload, kind)
    } catch (err) {
      console.warn(`[reasoning] model call failed: ${(err as Error).message}`)
      return null
    }

    // Stage C of model-lock-and-portable-reasoning: iterative refine
    // pass. ONLY runs in the one-shot path — when iterative paragraph
    // chain mode is on, the chain itself IS the iteration and stacking
    // refine on top would mean 8+ Flash calls per preflight (too much).
    const refineEnabled = (() => {
      try { return getFlag<boolean>("reasoning.iterative_refine_enabled", payload.sysbasePath) } catch { return true }
    })()
    if (shouldRunIterativeRefine({ kind, model: payload.model, flagEnabled: refineEnabled, complexity })) {
      try {
        const refinedRaw = await callReasonerWithTimeout(payload, kind, buildCritiqueUserTurn(payload, kind, raw))
        raw = refinedRaw || raw
        console.log(`[reasoning] iterative refine pass complete for trigger=${payload.trigger} pipeline=${kind}`)
      } catch (err) {
        console.warn(`[reasoning] iterative refine failed, keeping draft: ${(err as Error).message}`)
      }
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
    const repaired = repairReasoningResponse(obj) as Record<string, unknown>
    // Iterative chain override: if we assembled the chain ourselves,
    // ENFORCE it on the parsed envelope. The synthesis call sometimes
    // drops the chain or rewrites paragraphs — overriding here
    // preserves what we actually deliberated through. The chain values
    // come from our own per-step parsing so they're already string-safe.
    if (assembledChain) {
      repaired.reasoningChain = assembledChain.slice(0, 10)
    }
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
  //
  // Stage 4 of llm-iterative-intent-classification: when the run has
  // a runId, the smart classifier in user-message.ts has already
  // cached the resolved intent (LLM chain on the first turn, cache
  // hit thereafter). Reading from the cache here keeps `pickPipeline`
  // sync while still benefiting from the LLM's classification.
  // Cache miss (no runId, or legacy callers) falls back to the
  // sync regex — same behaviour as before Stage 4.
  const hint: IntentHint = getCachedIntentOrRegex(payload.runId, payload.userMessage)
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
  const maxOutputTokens = (() => {
    try { return getFlag<number>("reasoning.max_output_tokens", payload.sysbasePath) } catch { return 2_500 }
  })()

  // Stage D of model-lock-and-portable-reasoning: pick the backend by
  // the run's main model + which API keys are configured. The
  // `reasoning.backend` flag lets operators pin one backend explicitly;
  // `"auto"` (default) defers to the model-driven policy in
  // free-tier-policy.ts.
  const flagOverride = (() => {
    try { return getFlag<string>("reasoning.backend", payload.sysbasePath) } catch { return "auto" }
  })()
  const backend = pickReasonerBackend({ model: payload.model ?? null, flagOverride })
  if (!backend) {
    // No backend can serve this run. Surface the same error shape the
    // pre-Stage-D path used so the caller's existing handling (try/catch
    // in runReasoning → null return → legacy mode) still works.
    throw new Error("No reasoner backend available — set GEMINI_API_KEY, ANTHROPIC_API_KEY, or OPENROUTER_API_KEY")
  }
  // Stage E: stash the resolved backend so the response builder can
  // surface it on ClientResponse for CLI telemetry. Write-once-per-run
  // in practice (env doesn't shift mid-run); re-writes are no-ops.
  if (payload.runId) {
    reasonerBackendByRun.set(payload.runId, backend)
  }

  return callReasonerBackend(backend, {
    payload,
    kind,
    userTurnOverride,
    defaultUserTurn: buildUserTurn(payload, kind),
    maxOutputTokens,
    systemInstruction: getPipelineSystemPrompt(kind),
  })
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
 * Iterative paragraph chain (paragraph-by-paragraph deliberation).
 *
 * Each iteration is its own Flash call that produces ONE paragraph,
 * seeing all prior paragraphs as context. Anti-staleness: the reasoner
 * can REVISE a prior paragraph instead of appending — sets supersedes
 * to the paragraph's index and writes the corrected paragraph.
 *
 * Hard cap of `MAX_ITERATIVE_STEPS` iterations to prevent runaway. The
 * reasoner can also set `done: true` to end the chain early when
 * everything important has been said.
 *
 * Returns the assembled chain (may be shorter than the max if `done`
 * was set or a step failed). Empty array on total failure — caller
 * falls back to the one-shot path.
 */
const MAX_ITERATIVE_STEPS = 6

interface IterativeStepResponse {
  paragraph: string
  done: boolean
  supersedes: number | null
}

async function runIterativeChain(payload: ReasoningPayload, kind: PipelineKind): Promise<string[]> {
  const paragraphs: string[] = []
  for (let i = 0; i < MAX_ITERATIVE_STEPS; i++) {
    const userTurn = buildIterativeChainUserTurn(payload, kind, paragraphs, i, MAX_ITERATIVE_STEPS)
    let raw: string
    try {
      raw = await callReasonerWithTimeout(payload, kind, userTurn)
    } catch (err) {
      console.warn(`[reasoning] iterative chain step ${i + 1} failed: ${(err as Error).message}; stopping with ${paragraphs.length} paragraph(s)`)
      break
    }
    const step = parseIterativeStep(raw)
    if (!step) {
      console.warn(`[reasoning] iterative chain step ${i + 1} unparseable; stopping with ${paragraphs.length} paragraph(s)`)
      break
    }
    if (typeof step.supersedes === "number" && step.supersedes >= 0 && step.supersedes < paragraphs.length) {
      console.log(`[reasoning] iterative chain step ${i + 1} supersedes paragraph ${step.supersedes}`)
      paragraphs[step.supersedes] = step.paragraph
    } else {
      paragraphs.push(step.paragraph)
    }
    if (step.done) {
      console.log(`[reasoning] iterative chain marked done at step ${i + 1} (${paragraphs.length} paragraph(s))`)
      break
    }
  }
  return paragraphs
}

function parseIterativeStep(raw: string): IterativeStepResponse | null {
  try {
    const obj = JSON.parse(stripFences(raw)) as Record<string, unknown>
    const paragraph = typeof obj.paragraph === "string" ? obj.paragraph.trim() : ""
    if (!paragraph) return null
    return {
      paragraph,
      done: obj.done === true,
      supersedes: typeof obj.supersedes === "number" && Number.isFinite(obj.supersedes) ? obj.supersedes : null,
    }
  } catch {
    return null
  }
}

function buildIterativeChainUserTurn(
  payload: ReasoningPayload,
  kind: PipelineKind,
  paragraphs: string[],
  index: number,
  total: number,
): string {
  const parts: string[] = []
  parts.push(`PIPELINE: ${kind}`)
  parts.push(`TRIGGER: ${payload.trigger} (iterative chain step ${index + 1} of up to ${total})`)
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
  parts.push("You are building a reasoning chain ONE paragraph at a time. Each step you produce ONE plain-prose mid-to-long paragraph (3-6 sentences) that BUILDS ON or REVISES the prior paragraphs.")

  if (paragraphs.length === 0) {
    parts.push("")
    parts.push("This is the FIRST paragraph. Restate what the user is asking in your own words. Identify what's ambiguous, under-specified, or hidden behind defaults. Don't list — write naturally, the way a senior engineer thinks out loud at the start of a problem.")
  } else {
    parts.push("")
    parts.push(`PRIOR PARAGRAPHS (${paragraphs.length} so far, indexed 0-${paragraphs.length - 1}):`)
    paragraphs.forEach((p, i) => {
      parts.push("")
      parts.push(`[${i}] ${p}`)
    })
    parts.push("")
    parts.push(`Now produce paragraph ${index + 1}. Build on or extend the prior paragraphs — reference them, deepen their analysis, address something they missed. Continue the deliberation: alternatives, trade-offs, root causes, investigation leads, self-critique, final justification — pick whichever move comes next in the engineer's natural thinking.`)
    parts.push("")
    parts.push("ANTI-STALENESS: if a prior paragraph's reasoning has become WRONG given your current thinking, REVISE it. Set \"supersedes\": <its index 0-based> and write the corrected paragraph in its place. Use this when new thinking invalidates a prior assumption — don't leave stale claims in the chain.")
    parts.push("")
    parts.push(`BE SMART ABOUT DEPTH: if you've already covered everything that matters about THIS task, set "done": true with a brief closing paragraph. Don't pad to ${total} when ${paragraphs.length} is enough.`)
  }

  parts.push("")
  parts.push("Output a JSON object exactly:")
  parts.push(`{"paragraph": "<one mid-to-long paragraph, 3-6 sentences, plain prose>", "done": <boolean — true if chain is complete>, "supersedes": <integer 0-${Math.max(paragraphs.length - 1, 0)} if revising, null if appending>}`)
  parts.push("")
  parts.push("Output ONLY that JSON object. Nothing else.")
  return parts.join("\n")
}

/**
 * Final synthesis call: after the iterative chain has been assembled,
 * one Flash call takes the full chain + the original task and produces
 * the structured brief fields (implementBrief / bugBrief / etc).
 *
 * The pipeline system prompt instructs Flash on the full envelope
 * shape; we ask it to use the chain as-is and fill in the structured
 * fields. Post-parse the caller overrides reasoningChain with our
 * assembled chain — defensive against Flash dropping or re-writing it
 * during synthesis.
 */
async function synthesizeStructuredBrief(payload: ReasoningPayload, kind: PipelineKind, chain: string[]): Promise<string> {
  const userTurn = buildSynthesisUserTurn(payload, kind, chain)
  return await callReasonerWithTimeout(payload, kind, userTurn)
}

function buildSynthesisUserTurn(payload: ReasoningPayload, kind: PipelineKind, chain: string[]): string {
  const parts: string[] = []
  parts.push(`PIPELINE: ${kind}`)
  parts.push(`TRIGGER: ${payload.trigger} (chain synthesis)`)
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
  parts.push("REASONING CHAIN (built paragraph-by-paragraph across prior iterations):")
  chain.forEach((p) => {
    parts.push("")
    parts.push(p)
  })
  parts.push("")
  parts.push("Now produce the FULL JSON envelope for this pipeline. The envelope's `reasoningChain` field MUST be the paragraphs above, verbatim and in order. The structured fields (implementBrief / bugBrief / decisionBrief / etc — whichever matches the pipeline) reflect the conclusions reached in the chain.")
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
