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
import { getSystemRulesSection } from "./sections/system-rules.js"
import { getToolsSection } from "./sections/tools.js"
import { getTaskGuidelinesSection } from "./sections/task-guidelines.js"
import { getOutputEfficiencySection } from "./sections/output-efficiency.js"
import { getEnvInfoSection, type EnvInfoCtx } from "./sections/env-info.js"
import { getModelSpecificSection } from "./sections/model-specific.js"

export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY = "═══ SYSTEM_PROMPT_DYNAMIC_BOUNDARY ═══"

export interface PromptCtx extends EnvInfoCtx {
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
    { id: "system_rules", priority: 10, cacheable: true, content: getSystemRulesSection() },
    { id: "tools", priority: 20, cacheable: true, content: getToolsSection() },
    { id: "task_guidelines", priority: 30, cacheable: true, content: getTaskGuidelinesSection() },
    { id: "output_efficiency", priority: 40, cacheable: true, content: getOutputEfficiencySection() },
    { id: "env_info", priority: 100, cacheable: false, content: getEnvInfoSection(ctx) },
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
