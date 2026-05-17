/**
 * Modular system prompt assembly.
 *
 * Sections are sorted by priority (lower = earlier) and split into a cacheable
 * head and a non-cacheable tail. The two halves are joined by an explicit
 * SYSTEM_PROMPT_DYNAMIC_BOUNDARY marker so providers that support
 * provider-side caching can split on it later. For now Gemini doesn't wire
 * this boundary into its `cachedContent` API — that's tracked as a follow-up.
 */

import { getIdentitySection } from "./sections/identity.js"
import { getSystemRulesSection, type SystemRulesGate } from "./sections/system-rules.js"
import { getToolsSection } from "./sections/tools.js"
import { getTaskGuidelinesSection } from "./sections/task-guidelines.js"
import { getOutputEfficiencySection } from "./sections/output-efficiency.js"
import { getEnvInfoSection, type EnvInfoCtx } from "./sections/env-info.js"
import { getModelSpecificSection } from "./sections/model-specific.js"
import { getProjectMemorySection, type ProjectMemoryCtx } from "./sections/project-memory.js"
import { getPlanModeSection, type PlanModeCtx } from "./sections/plan-mode.js"
import { getReasoningBriefSection, type ReasoningBriefCtx } from "./sections/reasoning-brief.js"
import { getLearnedMemorySection, type LearnedMemoryCtx } from "./sections/learned-memory.js"
import { getInvestigationSection } from "./sections/investigation.js"
import { getTaskLedgerSection, type TaskLedgerCtx } from "./sections/task-ledger.js"
import { getProjectStateSection, type ProjectStateCtx } from "./sections/project-state.js"
import { getNodeEsmRulesSection } from "./sections/node-esm-rules.js"

export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY = "═══ SYSTEM_PROMPT_DYNAMIC_BOUNDARY ═══"

export interface PromptCtx extends EnvInfoCtx, ProjectMemoryCtx, PlanModeCtx, ReasoningBriefCtx, LearnedMemoryCtx, TaskLedgerCtx, SystemRulesGate, ProjectStateCtx {
  model?: string
}

interface PromptSection {
  id: string
  priority: number
  cacheable: boolean
  content: string | null
}

export interface BuiltPrompt {
  /** The full assembled system prompt — what providers send today. */
  full: string
  /** Cacheable portion (everything before the dynamic boundary). */
  cacheable: string
  /** Non-cacheable portion (everything after the dynamic boundary). */
  dynamic: string
}

export function buildSystemPrompt(ctx: PromptCtx = {}): BuiltPrompt {
  const sections: PromptSection[] = [
    { id: "identity", priority: 0, cacheable: true, content: getIdentitySection() },
    // Phase 18 Stage 5: the system-rules section is now ctx-aware. The
    // taskPlan instruction renders only when the gate matches (`implement`
    // intent + complexity >= medium). `cacheable: true` still holds — for
    // a given run the gate inputs are stable, so the prompt prefix is
    // stable across turns of the same run; cache invalidation across runs
    // is unchanged.
    { id: "system_rules", priority: 10, cacheable: true, content: getSystemRulesSection({ runIntent: ctx.runIntent, complexity: ctx.complexity, gatingEnabled: ctx.gatingEnabled }) },
    { id: "tools", priority: 20, cacheable: true, content: getToolsSection() },
    { id: "task_guidelines", priority: 30, cacheable: true, content: getTaskGuidelinesSection() },
    // Stage 1 of agent-code-correctness plan: Node-ESM + TypeScript
    // import rules. Cacheable — rules are static. Sits after
    // task_guidelines (general workflow) and before output_efficiency
    // (formatting) so the model reads the IMPORT semantics before
    // any per-turn output considerations.
    { id: "node_esm_rules", priority: 35, cacheable: true, content: getNodeEsmRulesSection() },
    { id: "output_efficiency", priority: 40, cacheable: true, content: getOutputEfficiencySection() },
    // Stage 1 of command-first-investigation: investigation patterns
    // section. Non-cacheable because it reads ctx.platform to render
    // bash vs PowerShell forms. Sits BETWEEN env_info (which surfaces
    // the platform identifier) and the reasoning_brief (which renders
    // the THINKING block) so the model sees the platform, the patterns,
    // then the preflight deliberation in that order.
    { id: "investigation", priority: 102, cacheable: false, content: getInvestigationSection(ctx) },
    // Stage 2 of free-tier quality enforcement: persistent task ledger.
    // Always-visible-when-non-empty so the agent has the full subtask
    // list anchored every turn (closes the "AI forgot what to do"
    // failure mode). Sits AFTER env_info + investigation patterns
    // (which orient the model on the system), BEFORE reasoning_brief
    // (which delivers per-turn instructions) so unfinished work is the
    // last thing the model sees before the brief.
    { id: "task_ledger", priority: 103, cacheable: false, content: getTaskLedgerSection(ctx) },
    { id: "env_info", priority: 100, cacheable: false, content: getEnvInfoSection(ctx) },
    // Stage 1 of agent-runtime-fixes plan: project-state block. Sits
    // BEFORE the reasoning_brief so the brief reads against the
    // classified repo shape ("EMPTY → scaffold from scratch" /
    // "EXISTING LARGE → investigate before write"). Non-cacheable
    // because the brief is per-run.
    { id: "project_state", priority: 104, cacheable: false, content: getProjectStateSection(ctx) },
    { id: "project_memory", priority: 105, cacheable: false, content: getProjectMemorySection(ctx) },
    { id: "learned_memory", priority: 106, cacheable: false, content: getLearnedMemorySection(ctx) },
    { id: "reasoning_brief", priority: 107, cacheable: false, content: getReasoningBriefSection(ctx) },
    { id: "plan_mode", priority: 108, cacheable: false, content: getPlanModeSection(ctx) },
    { id: "model_specific", priority: 110, cacheable: false, content: getModelSpecificSection(ctx.model) },
  ]

  const active = sections
    .filter((s) => s.content !== null && s.content !== "")
    .sort((a, b) => a.priority - b.priority)

  const cacheable = active.filter((s) => s.cacheable).map((s) => s.content as string).join("\n\n")
  const dynamic = active.filter((s) => !s.cacheable).map((s) => s.content as string).join("\n\n")

  const full = dynamic
    ? `${cacheable}\n\n${SYSTEM_PROMPT_DYNAMIC_BOUNDARY}\n\n${dynamic}`
    : cacheable

  return { full, cacheable, dynamic }
}
