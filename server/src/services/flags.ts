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
