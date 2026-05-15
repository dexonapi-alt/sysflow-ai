/**
 * Stage D of model-lock-and-portable-reasoning plan: pluggable reasoner
 * backends.
 *
 * Before Stage D, the reasoner was hardcoded to Gemini Flash in
 * `task-reasoner.ts: callReasoner`. If `GEMINI_API_KEY` was missing /
 * IP-blocked / rate-limited, every Phase-5/10/11/15/16 system silently
 * degraded for every main model — including paid claude / OpenRouter
 * runs where a working ANTHROPIC_API_KEY or OPENROUTER_API_KEY was
 * available. User feedback: *"currently its only gemini have that
 * reasoning and all other systems, we need all models to have all
 * system gemini have"*.
 *
 * The dispatcher takes a `ReasonerBackend` choice and a payload, and
 * returns the raw JSON envelope string the existing pipeline parsers
 * consume. Each backend handles its own auth, transport, and provider
 * quirks. The dispatcher itself is dumb — it just picks the right
 * function.
 *
 * Backend selection lives in `free-tier-policy.ts: pickReasonerBackend`
 * — same module that owns the other free-tier-vs-paid routing. The
 * dispatcher imports nothing from that module so the backends stay
 * independent of selection policy.
 *
 * Cross-backend fallback is OUT OF SCOPE (see plan's *Out of scope*).
 * If Anthropic Haiku rate-limits, we don't fall over to Gemini Flash
 * automatically. Transient hiccups are caught by the
 * `callReasonerWithTimeout` wrapper; persistent failures surface so
 * operators know their backend is degraded.
 */

import type { PipelineKind } from "../pipelines/index.js"
import type { ReasoningPayload } from "../task-reasoner.js"
import { callGeminiBackend } from "./gemini-backend.js"
import { callAnthropicBackend } from "./anthropic-backend.js"
import { callOpenRouterBackend } from "./openrouter-backend.js"

/** Backend identifier. `auto` is a SELECTOR value used in the flag
 *  system; it never reaches the dispatcher (the policy module resolves
 *  it to one of the concrete three before dispatch). */
export type ReasonerBackend = "gemini" | "anthropic" | "openrouter"

/**
 * Shared signature each backend exports. The dispatcher calls one of
 * these per `callReasoner` invocation. Backends own:
 *   - API-key check (throw a clearly-typed error when absent so the
 *     dispatcher can downgrade to legacy mode)
 *   - System prompt construction (always `getPipelineSystemPrompt(kind)`)
 *   - User-turn shape (override-aware so iterative-refine + critique
 *     passes keep working)
 *   - Response parsing — return the raw string the pipeline parsers
 *     already accept
 */
export interface BackendCallArgs {
  payload: ReasoningPayload
  kind: PipelineKind
  /**
   * Optional user-turn override. Used by Stage C's iterative-refine
   * pass (`buildCritiqueUserTurn`) and the iterative paragraph chain
   * (`buildIterativeChainUserTurn`). Backends that need the default
   * call `buildUserTurn` themselves — keeping `buildUserTurn` in the
   * task-reasoner module avoids forcing every backend to re-implement it.
   */
  userTurnOverride?: string
  /**
   * Default user turn — pre-built by the dispatcher so each backend
   * doesn't have to re-import `buildUserTurn`. Backends use this when
   * `userTurnOverride` is undefined.
   */
  defaultUserTurn: string
  /** Max tokens to request from the backend. Resolved at the dispatcher
   *  layer via the `reasoning.max_output_tokens` flag. */
  maxOutputTokens: number
  /** Resolved system instruction. Same for every backend — they pass
   *  it verbatim to whatever field their provider expects. */
  systemInstruction: string
}

/**
 * Dispatcher. Picks the backend function by `backend`. The user-turn
 * resolution + max-tokens resolution + system-instruction resolution
 * happen here so the three backend files stay focused on transport.
 *
 * Returns the raw response text — same contract every backend agrees
 * on. Caller is responsible for JSON-parsing + repair (the existing
 * `parseAndRepair` flow in `task-reasoner.ts`).
 */
export async function callReasonerBackend(backend: ReasonerBackend, args: BackendCallArgs): Promise<string> {
  switch (backend) {
    case "gemini":
      return callGeminiBackend(args)
    case "anthropic":
      return callAnthropicBackend(args)
    case "openrouter":
      return callOpenRouterBackend(args)
    default: {
      const _exhaustive: never = backend
      throw new Error(`Unknown reasoner backend: ${_exhaustive as string}`)
    }
  }
}
