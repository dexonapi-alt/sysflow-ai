/**
 * Response format and JSON schema rules. Cacheable when the gate
 * inputs are stable for the run, which they are — `runIntent` and
 * `complexity` are classified once at the handler entry and persist
 * for the lifetime of the run (see plan
 * `applied/2026-05-07-phase-19-task-display-selectivity.md`).
 *
 * Phase 18 Stage 5: the taskPlan instruction is conditional. Only
 * `implement`-class runs with medium/complex complexity see the
 * "FIRST RESPONSE must include taskPlan" rubric. Everything else
 * (simple Q&A, summary, bug-fix Q&A, trivial single-line implements)
 * sees the leaner "FIRST RESPONSE — no taskPlan" variant so the
 * model doesn't manufacture a multi-step plan ceiling the
 * conversation. Composes with Phase 19's cli render gate as
 * defense-in-depth.
 */

export interface SystemRulesGate {
  /**
   * Classified intent for the run. Same value used by Phase 19's
   * `<AgentStream>` gate. `null` (legacy / pre-classification
   * window) defaults to the include-taskPlan rubric so behaviour
   * pre-Phase-18 is preserved.
   */
  runIntent?: "simple" | "summary" | "bug" | "implement" | null
  /**
   * Task complexity from `analyzeTaskComplexity`. Even on `implement`
   * runs, simple-complexity tasks (typo fix, single-line rename)
   * omit the taskPlan instruction. `null` defaults to include.
   */
  complexity?: "simple" | "medium" | "complex" | null
  /**
   * Resolved value of `quality.taskplan_emission_gating_enabled`.
   * Off-switch: when false, the include-taskPlan rubric always
   * renders regardless of intent / complexity. Defaults to true
   * (gate is on) so callers don't have to thread the flag through
   * just to get the default behaviour.
   */
  gatingEnabled?: boolean
}

/**
 * True when the system prompt should ASK the model to emit a
 * taskPlan on its first response. Pure helper — exported so
 * `base-provider.ts`'s defensive drop (Stage 5b) can use the same
 * decision logic as the prompt-builder.
 */
export function shouldIncludeTaskPlanInstruction(gate: SystemRulesGate): boolean {
  // Off-switch: when the flag is explicitly false, always include
  // taskPlan rubric (pre-Phase-18 behaviour).
  if (gate.gatingEnabled === false) return true

  // Pre-classification fallback: when we don't know the intent or
  // complexity yet, keep the rubric so the model isn't surprised
  // by a missing instruction it expects to see.
  if (gate.runIntent == null) return true
  if (gate.complexity == null) return true

  // Phase 18 Stage 5: gate matches the user-visible Phase 19 gate.
  // Only `implement` runs with non-trivial complexity surface the
  // taskPlan rubric.
  if (gate.runIntent !== "implement") return false
  if (gate.complexity === "simple") return false
  return true
}

export function getSystemRulesSection(gate: SystemRulesGate = {}): string {
  const includeTaskPlan = shouldIncludeTaskPlanInstruction(gate)

  const head = `═══ RESPONSE FORMAT ═══

All file paths are relative to the PROJECT ROOT. NEVER write to "sysbase/".
Respond with ONLY valid JSON. No markdown fences outside JSON.`

  const firstResponseBlock = includeTaskPlan
    ? `FIRST RESPONSE (must include taskPlan):
{ "kind": "needs_tool", "reasoning": "brief reasoning", "tool": "tool_name", "args": { ... }, "content": "what you are doing",
  "taskPlan": { "title": "Short task title", "steps": ["Step 1 description", "Step 2 description", ...] }
}
The taskPlan is YOUR implementation plan — the specific steps YOU will take to complete this task.
Each step should be concrete and specific to the prompt (e.g. "Build Navbar component", "Configure Tailwind CSS").
Do NOT use generic steps. Tailor every step to the actual task.
Only include taskPlan in your FIRST response. Omit it in subsequent responses.`
    : `FIRST RESPONSE (NO taskPlan — this is not an implement-class task):
{ "kind": "needs_tool", "reasoning": "brief reasoning", "tool": "tool_name", "args": { ... }, "content": "what you are doing" }
Do NOT include a \`taskPlan\` field. The user asked a question / requested a single-file fix / asked for a summary — there's no multi-step plan to surface. Answer naturally via tool calls + completion message.`

  return `${head}

${firstResponseBlock}

SUBSEQUENT RESPONSES (single tool):
{ "kind": "needs_tool", "reasoning": "brief reasoning", "tool": "tool_name", "args": { ... }, "content": "what you are doing" }

PARALLEL TOOLS (independent actions — use for speed):
{ "kind": "needs_tool", "reasoning": "brief reasoning", "tools": [
  { "id": "tc_0", "tool": "read_file", "args": { "path": "src/a.ts" } },
  { "id": "tc_1", "tool": "read_file", "args": { "path": "src/b.ts" } }
], "content": "Reading files in parallel" }

COMPLETED / FAILED / WAITING:
{ "kind": "completed" | "failed" | "waiting_for_user", "reasoning": "brief reasoning", "content": "message" }`
}
