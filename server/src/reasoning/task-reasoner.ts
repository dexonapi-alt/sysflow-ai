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

import { GoogleGenerativeAI } from "@google/generative-ai"
import { classifyIntent, type IntentHint } from "./intent-classifier.js"
import { reasoningEnvelopeSchema, assertEnvelopeShape, type ReasoningBrief, type ReasoningTrigger } from "./reasoning-schema.js"
import { getReasoningCache, setReasoningCache } from "./reasoning-cache.js"
import { applyCriticalContextDetector } from "./critical-context-detector.js"
import { getPipelineSystemPrompt, type PipelineKind } from "./pipelines/index.js"
import { getFlag } from "../services/flags.js"

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
  const flagName = (payload.trigger === "chunk_plan" || payload.trigger === "chunk_reflect")
    ? "reasoning.chunked_loop_enabled"
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
    }
  }

  // Cache lookup.
  const cacheKey = {
    trigger: payload.trigger,
    userMessage: payload.userMessage,
    cwd: payload.cwd ?? "",
    model: payload.model,
    projectMemoryMtime: payload.projectMemoryMtime ?? 0,
    errorContext: payload.context ? JSON.stringify(payload.context).slice(0, 2000) : "",
  }
  const cached = getReasoningCache(cacheKey)
  if (cached) {
    console.log(`[reasoning] cache hit trigger=${payload.trigger} pipeline=${cached.pipeline}`)
    return cached
  }

  // Model call.
  let raw: string
  try {
    raw = await callReasoner(payload, kind)
  } catch (err) {
    console.warn(`[reasoning] model call failed: ${(err as Error).message}`)
    return null
  }

  // Parse + validate.
  let parsed: ReasoningBrief
  try {
    const json = stripFences(raw)
    const obj = JSON.parse(json)
    parsed = reasoningEnvelopeSchema.parse(obj)
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
  // preflight: defer to intent classifier.
  const hint: IntentHint = classifyIntent(payload.userMessage)
  return hint
}

async function callReasoner(payload: ReasoningPayload, kind: PipelineKind): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set")
  const genAI = new GoogleGenerativeAI(apiKey)

  const maxOutputTokens = (() => {
    try { return getFlag<number>("reasoning.max_output_tokens", payload.sysbasePath) } catch { return 2_500 }
  })()

  // Always run reasoning on Gemini Flash regardless of the main model — cheap + fast.
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

  const userTurn = buildUserTurn(payload, kind)
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

function stripFences(s: string): string {
  const trimmed = s.trim()
  if (trimmed.startsWith("```")) {
    return trimmed.replace(/^```(?:json)?\s*/, "").replace(/```\s*$/, "")
  }
  return trimmed
}
