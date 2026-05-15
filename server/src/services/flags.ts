/**
 * Typed feature flag registry.
 *
 * Three sources, in precedence order:
 *   1. process.env.SYSFLOW_FLAG_<UPPER_SNAKE>  — env override (parsed via the flag's parser)
 *   2. <sysbasePath>/flags.json                — JSON file (must be passed in by the caller)
 *   3. registered default                      — what defineFlag was called with
 *
 * Flags are memoised per-process; tests can call resetFlagCache() to clear.
 *
 * No callers yet outside this module — wire-in happens in subsequent commits.
 */

import fs from "node:fs"
import path from "node:path"

type Parser<T> = (raw: string) => T

interface RegisteredFlag<T> {
  name: string
  default: T
  parser: Parser<T>
}

const flags = new Map<string, RegisteredFlag<unknown>>()
let memo = new Map<string, unknown>()
let cachedFile: { path: string; mtime: number; data: Record<string, unknown> } | null = null

function envKey(name: string): string {
  return "SYSFLOW_FLAG_" + name.replace(/[.-]/g, "_").toUpperCase()
}

function defineFlag<T>(name: string, defaultValue: T, parser: Parser<T>): void {
  flags.set(name, { name, default: defaultValue, parser } as RegisteredFlag<unknown>)
}

const parseBool: Parser<boolean> = (raw) => raw === "1" || raw.toLowerCase() === "true" || raw.toLowerCase() === "yes"
const parseNumber: Parser<number> = (raw) => {
  const n = Number(raw)
  if (Number.isNaN(n)) throw new Error(`Invalid number: ${raw}`)
  return n
}

// ─── Initial flag inventory ───
defineFlag("compaction.autocompact_threshold_buffer", 13_000, parseNumber)
defineFlag("compaction.microcompact_keep_last_n", 5, parseNumber)
defineFlag("tool.persist_threshold_bytes", 10 * 1024, parseNumber)
defineFlag("prompt.dynamic_boundary_enabled", true, parseBool)
defineFlag("prompt.frontend_section_only_when_relevant", false, parseBool)

// ─── Phase 5: reasoning system kill switches + tunables ───
defineFlag("prompt.preflight_reasoning_enabled", true, parseBool)
defineFlag("prompt.self_invoked_reasoning_enabled", true, parseBool)
defineFlag("prompt.on_error_reasoning_enabled", true, parseBool)
defineFlag("prompt.on_completion_reasoning_enabled", true, parseBool)
defineFlag("reasoning.max_output_tokens", 2_500, parseNumber)
defineFlag("reasoning.max_self_invocations_per_run", 5, parseNumber)
defineFlag("reasoning.cache_ttl_minutes", 30, parseNumber)

// ─── Phase 8: persistent reasoning memory ───
defineFlag("prompt.learned_memory_enabled", true, parseBool)
defineFlag("memory.stale_after_days", 60, parseNumber)
defineFlag("memory.stale_after_days_high_use", 180, parseNumber)
defineFlag("memory.file_max_bytes", 102_400, parseNumber)
defineFlag("memory.max_recall_entries", 12, parseNumber)

// ─── Phase 15 Stage 4: active memory feedback loop ───
// When true, the model's `memoryFeedback: { confirmed, contradicted }`
// field on each response is processed via applyMemoryFeedback — bumping
// useCount on confirmed entries, advancing contradictionCount on
// contradicted ones (with cross-validation guards in feedback.ts).
// Off-switch in case free-tier hallucinations make the signal noisy.
defineFlag("memory.active_confirmation_enabled", true, parseBool)

// ─── Phase 16 Stage 3: chained preflight elaboration on free-tier ───
// When true (and gate matches: free-tier model + complexity ≥ medium
// + preflight confidence < HIGH), a second-stage `implement_elaborate`
// Flash runs on top of the preflight implement brief. Re-examines the
// chosen approach (whyThisApproach / whyNotAlternative / preconditions
// / re-scored confidence). Output feeds the main model's prompt
// alongside the original implement brief. Off-switch in case free-tier
// rate limits make the extra Flash expensive — degrades to today's
// behaviour (single-stage preflight, no chain).
defineFlag("reasoning.chained.preflight_elaboration_enabled", true, parseBool)

// ─── Phase 16 Stage 4: chained divergence second-look on borderline ───
// When true (and gate matches: free-tier model + first divergence verdict
// score in the borderline band 40-60), a second `divergence_check` Flash
// fires with the first verdict carried in its context. The second
// verdict replaces the first — the deeper look is what we trust. Only
// fires inside the awareness block, which is already gated by
// `awareness.enabled`; this flag is a per-stage off-switch that doesn't
// affect the first-pass divergence call.
defineFlag("reasoning.chained.divergence_second_look_enabled", true, parseBool)

// ─── Phase 10: chunked reasoning loop ───
// Default ON as of Stage 4 — the prompt now teaches the model to honour the
// planner's file list, so turning the loop on actually produces structured
// chunked behaviour. Set SYSFLOW_FLAG_REASONING_CHUNKED_LOOP_ENABLED=false
// (or flags.json) to disable. Falls back gracefully without GEMINI_API_KEY:
// runReasoning returns null, the chunked block degrades to legacy.
defineFlag("reasoning.chunked_loop_enabled", true, parseBool)
defineFlag("reasoning.max_chunks_per_run", 12, parseNumber)

// ─── Phase 11: awareness + adaptive recovery ───
// Default ON as of Stage 4 — heuristic detector + verification gate +
// LLM divergence pipeline + off-course modal are all live. Set
// SYSFLOW_FLAG_AWARENESS_ENABLED=false (or flags.json) to disable. With
// the flag off the awareness path short-circuits at the trigger gate in
// task-reasoner.ts and the per-chunk detector skips entirely. Thresholds
// are read by the confidence tracker via getFlag at evaluation time, so
// live tuning works without restarting the run.
defineFlag("awareness.enabled", true, parseBool)
defineFlag("awareness.threshold_off_course", 60, parseNumber)
defineFlag("awareness.threshold_blocked", 30, parseNumber)

// ─── Stage 4 of command-first-investigation plan ───
// When true (default), the divergence detector emits a
// `no_investigation_before_write` signal when the agent writes a file
// before running any read-only investigation commands. Mild signal
// (−15 confidence). Suppressed for trivial-complexity tasks. Set to
// false if it over-fires on a legitimate one-shot prompt pattern.
defineFlag("awareness.no_investigation_heuristic_enabled", true, parseBool)

// ─── Stage A of model-lock-and-portable-reasoning plan ───
// When true (default), the adapter does NOT walk MODEL_FALLBACK_CHAINS
// for explicit single-provider picks (claude-*, gemini-*, llama-70b,
// mistral-small). A rate-limited or failed call surfaces as a clear
// "rate-limited, swap model with /model" error instead of silently
// swapping providers (the user's reported "i used claude sonnet why it
// switches to gemini lol" symptom). `openrouter-auto` is exempt because
// the "auto" suffix is the user's explicit signal they expect cycling.
// Set to false to restore pre-Stage-A cross-provider fallback.
defineFlag("providers.lock_to_chosen_model", true, parseBool)

// ─── Stage C of model-lock-and-portable-reasoning plan ───
// When true (default), every reasoner call gets a critique-and-revise
// second pass — the reasoner is invoked with its own draft + "find
// weaknesses and rewrite" instructions, and the revised envelope is what
// the main model sees. Doubles reasoner spend per call when on;
// addresses user feedback *"reason over and over again like normal AI
// would"* — single-pass briefs often miss alternatives or trade-offs the
// model surfaces on the second look. Skip pipelines (summary /
// implement_elaborate / divergence) defined in `free-tier-policy.ts`'s
// `shouldRunIterativeRefine`. Free-tier users can flip this off via
// flags.json / env override if quota becomes tight.
defineFlag("reasoning.iterative_refine_enabled", true, parseBool)

// ─── Stage 1 of free-tier quality enforcement plan ───
// When true (default), the next tool-result message after any chunk
// that wrote files gets a `═══ VERIFY THE LAST CHUNK ═══` directive
// block forcing the agent to cat the files / find empty dirs / run
// typecheck BEFORE continuing. Free-tier always; paid only when
// chunk wrote ≥ 3 files AND complexity ≥ medium (see
// `shouldForceVerifyAfterWrite` in free-tier-policy.ts). User
// feedback: *"free models create errors, typos, forgot to implement
// in X folder, wrong implementations because it lacks checking every
// iteration"*. Kill switch in case the block bloats messages on a
// specific run.
defineFlag("quality.force_verify_after_write", true, parseBool)

// ─── Stage 3 of free-tier quality enforcement plan ───
// When true (default), every N chunks the system injects a
// `═══ REVIEW REQUIRED ═══` block forcing the agent to pause and
// read-back-and-reason about the recently-written files. Cadence:
// free-tier=2, paid=4 (see `getSelfReviewCadence` in
// free-tier-policy.ts). User feedback: *"lacks checking every
// iteration"* — without a forced pause, free models implement →
// implement → implement without ever verifying their own work
// landed coherently. Kill switch if cadence over-fires for a specific
// task pattern.
defineFlag("quality.mandatory_self_review_enabled", true, parseBool)

// ─── Stage 4 of free-tier quality enforcement plan ───
// When true (default), the heuristic divergence detector runs after
// EVERY tool result on free-tier runs — not just at chunk boundaries.
// Catches drift WITHIN a chunk (3-4 turns of bad direction before the
// boundary fires) and the new `same_action_repeated_in_session`
// heuristic which spots stuck-loops mid-chunk. Free-tier only (see
// `shouldRunPerStepDivergence` in free-tier-policy.ts). Kill switch if
// per-step firing produces too much log noise.
defineFlag("quality.per_step_divergence_for_free_tier", true, parseBool)

// ─── Stage 5 of free-tier quality enforcement plan ───
// When true (default), the divergence detector runs the conservative
// reasoner-vs-action cross-check: if the model's last reasoningChain
// paragraph stated a clear read-intent ("verify", "inspect", "check"
// …) but the action it emitted was a write_file / edit_file /
// batch_write / create_directory, fire a `reasoning_action_mismatch`
// signal. Catches the "said-X-did-Y" failure mode where the per-turn
// reasoning is decorative rather than load-bearing on the action.
// Kill switch in case the heuristic over-fires on a specific phrasing
// pattern.
defineFlag("quality.reasoning_action_cross_check_enabled", true, parseBool)

// ─── Stage D of model-lock-and-portable-reasoning plan ───
// Which reasoner backend to use. `"auto"` (default) lets
// `pickReasonerBackend` decide based on the run's main-model identifier
// + which API keys are configured. Operators who need to pin one
// backend (testing a specific provider, working around an outage) can
// set the flag to `"gemini"` / `"anthropic"` / `"openrouter"` directly.
// If the pinned backend's key isn't set, the reasoner returns null and
// the handlers degrade to legacy non-chunked behaviour (same path as
// the pre-Stage-D missing-GEMINI_API_KEY case).
const parseString: Parser<string> = (raw) => raw
defineFlag("reasoning.backend", "auto", parseString)

// ─── Stage 5 of command-first-investigation plan ───
// When true (default), the tool-result handler injects a one-shot
// `[BUDGET]` reminder telling the agent to switch from investigation
// to action when the count of safe-read-only `run_command` calls in
// the run so far exceeds `getInvestigationBudget(...)`. The reminder
// fires once per run (latched by an in-memory flag) so the agent
// isn't spammed if it keeps investigating; the divergence detector's
// existing `scope_creep` heuristic catches sustained over-investigation
// via the confidence tracker if the reminder is ignored.
defineFlag("quality.investigation_budget_reminder_enabled", true, parseBool)

// ─── Stage 5 of phase-18-pre-task-deep-reasoning plan ───
// When true (default), the system-rules section's "FIRST RESPONSE must
// include taskPlan" rubric is gated on the run's classified intent +
// complexity. Only `implement` runs with medium/complex complexity see
// the include-taskPlan variant; simple Q&A, summary, bug-fix Q&A, and
// trivial single-line implements see the no-taskPlan variant. Composes
// with Phase 19's cli render gate as defense-in-depth. Defensively the
// normalizer ALSO drops `taskPlan` from the response when the gate
// said skip — so a free-tier model that ignores the system-prompt
// instruction can't blow past the gate. Off-switch (`false`) restores
// the pre-Phase-18 always-include behaviour.
defineFlag("quality.taskplan_emission_gating_enabled", true, parseBool)

// ─── Plan 2026-05-15-llm-iterative-intent-classification.md ───
// Stage 4 — when true (default), the smart classifier's iterative
// LLM chain runs on prompts the regex doesn't HIGH-confidence commit
// on (everything except SIMPLE_PATTERNS matches). When false, the
// smart wrapper degrades to regex-only — pre-plan behaviour.
defineFlag("reasoning.intent_classification_via_llm_enabled", true, parseBool)
// Stage 5 — per-chain depth cap. Mirrors `MAX_ITERATIVE_STEPS` for
// the preflight chain so operators have one number for "how deep
// can iterative reasoning go on this run". The LLM's `done` flag
// drives most short-circuits — this is the runaway-safety ceiling.
// Lower if telemetry shows free-tier intent classification often
// running past iteration 3.
defineFlag("reasoning.intent_classification_max_iterations", 6, parseNumber)
// Stage 5 — when false, the smart classifier SKIPS the regex
// fast-path and routes every non-cached prompt through the LLM
// chain. Useful for telemetry / accuracy tuning — distribution of
// `intentClassificationSource` shifts to mostly `chain` /
// `regex_fallback` and the `regex_simple` bucket becomes 0. Default
// true (regex fast-path on) keeps trivial cases cheap.
defineFlag("reasoning.intent_classification_fast_path_regex_enabled", true, parseBool)

// ─── Plan 2026-05-15-forced-error-reasoning-and-recovery.md Stage 3 ───
// When true (default), tool errors fire the error-reasoning chain
// AND the `═══ ERROR — REASON THROUGH THIS ═══` block is injected
// into the next tool-result message. Closes the user-reported
// failure mode where the LLM ignores tool errors and proceeds to
// the next step without addressing them. Off-switch in case the
// block over-fires on benign warnings (the gate uses
// `isToolResultError` to filter out skipped / warning-only results).
defineFlag("quality.force_error_reasoning_enabled", true, parseBool)
// Stage 3: cap on iterations the error-reasoning chain runs. Default
// matches `MAX_ERROR_REASONING_ITERATIONS`. Lower if telemetry shows
// the reasoner often iterating past 2.
defineFlag("reasoning.error_reasoning_max_iterations", 4, parseNumber)

// Stage 4: when true (default), the next response after a tool
// error gets validated for acknowledgement. If the validator says
// the model ignored the error (no overlap with the error vocab AND
// didn't pivot to a different action / OR retried the exact same
// broken command), the handler rejects + retries with a stronger
// prompt. Hard cap at 3 rejections per run to prevent infinite
// loops; after the cap the system gives up and lets the run
// proceed (the Phase 11 awareness loop will catch sustained drift).
// Off-switch in case the validator over-fires on edge cases that
// surface in real telemetry.
defineFlag("quality.error_acknowledgement_rejection_enabled", true, parseBool)

// Stage 5: when true (default), tool errors recall matching prior
// `error_pattern` memory entries (platform + signature overlap) and
// surface them to the error-reasoning chain as `priorRecall`, AND
// successful recoveries (error → next-same-tool success) are recorded
// as new `error_pattern` entries for future runs to short-circuit on.
// Off-switch in case the recall surfaces stale fixes that wrong-foot
// the reasoner.
defineFlag("memory.error_pattern_recall_enabled", true, parseBool)

// ─── Iterative paragraph chain (follow-up to Stage C model-lock) ───
// When true (default), the preflight reasoner builds its reasoningChain
// paragraph-by-paragraph across N sequential Flash calls — each call
// sees prior paragraphs and may revise/supersede them. User feedback
// after Stage C shipped: the bulk THINKING block is correct but the
// model "doesn't remember" the individual steps; iterative one-thought-
// per-LLM-call solves this at the cost of N+1 Flash calls per preflight
// (vs 1 today). Gated by kind (implement / bug / decision only — not
// chunk pipelines) + complexity (skip simple) in free-tier-policy.ts's
// `shouldRunIterativeChain`. Set to false to restore the single-shot
// pre-iterative behaviour.
defineFlag("reasoning.iterative_paragraph_chain_enabled", true, parseBool)

export function getFlag<T = unknown>(name: string, sysbasePath?: string | null): T {
  const memoKey = `${name}::${sysbasePath ?? ""}`
  if (memo.has(memoKey)) return memo.get(memoKey) as T

  const reg = flags.get(name)
  if (!reg) throw new Error(`Unknown flag: ${name}`)

  // 1. env override
  const envRaw = process.env[envKey(name)]
  if (envRaw != null) {
    try {
      const v = reg.parser(envRaw) as T
      memo.set(memoKey, v)
      return v
    } catch (err) {
      console.warn(`[flags] env override for ${name} unparseable (${(err as Error).message}) — falling through`)
    }
  }

  // 2. flags.json
  if (sysbasePath) {
    const fileVal = readFlagFile(sysbasePath)[name]
    if (fileVal !== undefined) {
      memo.set(memoKey, fileVal)
      return fileVal as T
    }
  }

  // 3. default
  memo.set(memoKey, reg.default)
  return reg.default as T
}

function readFlagFile(sysbasePath: string): Record<string, unknown> {
  const filePath = path.join(sysbasePath, "flags.json")
  try {
    const stat = fs.statSync(filePath)
    if (cachedFile && cachedFile.path === filePath && cachedFile.mtime === stat.mtimeMs) {
      return cachedFile.data
    }
    const body = fs.readFileSync(filePath, "utf8")
    const parsed = JSON.parse(body)
    cachedFile = { path: filePath, mtime: stat.mtimeMs, data: parsed && typeof parsed === "object" ? parsed : {} }
    return cachedFile.data
  } catch {
    return {}
  }
}

export function resetFlagCache(): void {
  memo = new Map()
  cachedFile = null
}

export function listFlags(): Array<{ name: string; default: unknown }> {
  return Array.from(flags.values()).map((f) => ({ name: f.name, default: f.default }))
}
