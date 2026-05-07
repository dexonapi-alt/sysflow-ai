# Phase 18 — Pre-task deep reasoning + complexity-aware orchestration

- **Created:** 2026-05-07
- **Status:** draft
- **Scope:** Today every implement run produces a taskPlan unconditionally and every prompt routes through the same depth of preflight reasoning regardless of difficulty. The user's hypothesis: free-tier models flatten complexity — they treat easy tasks as complex and complex tasks as easy. Phase 18 makes the system distinguish, **think** about WHY before committing, and **gate** taskPlan generation on the task actually being a task.

## Goal

Before producing a task, the agent should reason internally: **What kind of task is this? What's the right approach? Why this approach over alternatives? Have I checked preconditions?** Today the answer to all of those is "the model figures it out" — which works for paid models and falls apart for free ones. Phase 18 promotes that judgment from "trust the model" to "system-level orchestration the cheap model has to obey".

End state for a turn:

1. **Intent classification** (already exists) decides simple / summary / bug / implement.
2. **Complexity classification** (already exists in `completion-guard.ts`, used post-hoc) is now invoked PRE-flight to decide easy / medium / complex.
3. **Pre-task reasoning** (a deeper stage of preflight, gated by intent + complexity) produces `whyThisApproach`, `whyNotAlternatives`, `preconditionsChecked`, before any taskPlan is generated.
4. **Pre-task confirmation** — a cheap second Flash call validates the approach against the user's literal prompt + memory's `original_intent` (Phase 15). If confidence is LOW after confirmation, the modal goes "ask the user before proceeding" instead of guessing.
5. **TaskPlan emission** is gated on intent === implement AND complexity ≥ medium. Simple tasks (typo fix, single-file edit, one-liner question) skip taskPlan entirely; medium and complex still produce one.

This phase composes with Phase 16 (which adds the chained Flash). Phase 18 specifies the WHY (when does the chain fire, what does each stage assess) while Phase 16 supplies the mechanics.

## Context from knowledge base

- `architecture.md: ## Chunked reasoning loop (Phase 10)` — preflight + chunk_plan + chunk_reflect are existing triggers; Phase 18 adds two new logical stages within the existing pre-flight slot, doesn't add new triggers.
- `decisions.md: ## Render natural agent steps, not "chunk N/M" UI` — taskPlan UX. Phase 18 makes the box stop appearing when there isn't actually a task to plan.
- `decisions.md: ## chunk planner cap of 5 files per chunk (not 8)` — Phase 18's complexity-aware chunk caps push this lower for simple, higher for complex.
- `gotchas.md: ## Continuation prompts ("continue the task") used to spawn the canned task pipeline` — Phase 18's gating must not regress this. `/continue` still routes via the existing path; Phase 18 only changes "should this PROMPT produce a task?" not "should we use the prior task?"
- `gotchas.md: ## Free models commit to a wrong direction at chunk 1` — exactly the failure mode pre-task reasoning + confirmation is meant to prevent. The complexity classifier was the post-hoc safety net; this phase moves it pre-flight.
- Phase 11 plan `applied/2026-05-06-phase-11-awareness-and-recovery.md` — `isFreeTierModel` + threshold bumps. Phase 18 uses the same pattern at the gating layer.

## Affected files

### Use the existing complexity classifier pre-flight
- `server/src/services/completion-guard.ts` — split: keep `analyzeTaskComplexity()` pure; rename the post-hoc gating to `validateCompletionAgainstComplexity()` if not already separate. (Phase 16 may have done this split — coordinate.)
- `server/src/handlers/user-message.ts` — invoke `analyzeTaskComplexity(prompt)` IMMEDIATELY after intent classification. Stash result on the run context.

### Pre-task reasoning stage
- `server/src/reasoning/pipelines/pre-task-reasoning-pipeline.ts` (new) — Flash call that takes `{userPrompt, intent, complexity, memoryContext, sessionHistory}` and emits:
  - `chosenApproach: string`
  - `whyThisApproach: string`
  - `alternatives: Array<{approach: string, reasonRejected: string}>`
  - `preconditionsToCheck: string[]` (e.g. "package.json present", "user is authenticated")
  - `confidence: HIGH | MEDIUM | LOW`
- `server/src/reasoning/task-reasoner.ts` — register the new pipeline. Add to `pickPipeline` routing for trigger `pre_task_reasoning`.

### Pre-task confirmation stage
- `server/src/reasoning/pipelines/task-confirmation-pipeline.ts` (new) — second Flash call that re-checks the chosen approach against the LITERAL user prompt + `original_intent` memory entry. Produces:
  - `aligned: boolean`
  - `mismatches: string[]`
  - `confirmedConfidence: HIGH | MEDIUM | LOW`

### Orchestrator
- `server/src/handlers/user-message.ts` — orchestrate the gated chain:
  1. Classify intent + complexity.
  2. If intent === "simple" OR (intent === "summary" AND complexity === "easy") → skip pre-task reasoning entirely. Main model gets a no-taskPlan instruction.
  3. Else → run pre-task reasoning. If confidence is HIGH AND complexity is "easy" → skip the confirmation stage (over-thinking guard).
  4. Else → run confirmation. If `aligned: false` OR `confirmedConfidence: LOW` → escalate via existing `ask_user` / awareness modal path.
  5. Pass the brief into main-model context.

### TaskPlan emission gating
- `server/src/providers/prompt/sections/system-rules.ts` — currently instructs ALL prompts to produce a taskPlan on first response. Replace with a routing-aware instruction that's only included for `pipeline === "implement"` AND `complexity ≥ medium`. For other pipelines, instruct to omit taskPlan.
- `server/src/providers/base-provider.ts` — already extracts taskPlan; add a server-side guard that drops it from the response when the routing said to skip (defensive — for free-tier models that ignore the instruction).

### Schema additions
- `server/src/reasoning/reasoning-schema.ts` — add `preTaskReasoningBriefSchema` + `taskConfirmationBriefSchema` to the discriminated union. Keep them additive.

### Tests
- `server/src/reasoning/__tests__/pre-task-reasoning-pipeline.test.ts` (new) — fixture-driven; assert each schema field shape and the routing trigger.
- `server/src/reasoning/__tests__/task-confirmation-pipeline.test.ts` (new) — alignment matrix (aligned vs mismatch); confidence transitions.
- `server/src/handlers/__tests__/user-message.test.ts` (extend) — routing matrix (simple → skip; complex → both stages; medium + HIGH → only stage 1).
- `server/src/services/__tests__/completion-guard.test.ts` (extend) — pre-flight callable shape works without dragging in post-hoc validation.

## Migrations / data

N/A. Pure runtime additions. Schema is additive.

## Hooks / skills / settings to update

- New flags:
  - `reasoning.pre_task_enabled` (default `true`).
  - `reasoning.pre_task_confirmation_enabled` (default `true`).
  - `reasoning.complexity_pre_flight_enabled` (default `true`). Off-switch in case the pre-flight invocation regresses anything.
- `.claude/knowledge/architecture.md` — add a "Pre-task reasoning" subsection.
- `.claude/knowledge/decisions.md` — entry on "complexity classifier moves pre-flight" + the alternatives rejected.
- `.claude/knowledge/gotchas.md` — track any free-tier-specific pre-task surprises.
- No `.claude/hooks/` changes.

## Dependencies

- Phase 15 should merge first so `original_intent` reading (Stage 5 of Phase 15) is available for the confirmation stage.
- Phase 16 and Phase 18 share the chained-reasoning helper (`runReasoningChain`). Whichever lands first builds it; the other reuses.
- Zero new npm packages. New flags via the existing flag system.

## Risks & mitigations

- **Adding two Flash stages per implement turn risks blowing the free-tier rate limit.** Mitigation: the gating is intentionally narrow — simple tasks skip both stages, easy + HIGH skip the confirmation. Target free-tier overhead: ≤ 1 extra Flash call per turn on average.
- **Complexity classifier was tuned for completion validation; it may over- or under-flag pre-flight.** Mitigation: A/B in testing; if the boundary is wrong, adjust the regex patterns in `completion-guard.ts: analyzeTaskComplexity()` rather than re-tune across multiple call sites.
- **Free models may produce a low-quality "whyThisApproach" that the system then trusts as gospel.** Mitigation: confirmation stage exists specifically to second-guess. If confirmation says `aligned: false`, the awareness modal fires (existing path).
- **Skipping taskPlan for simple prompts could regress the cli's progress-display.** Mitigation: cli already handles missing taskPlan gracefully (Phase 19's whole point). The agent stream still shows tool cards; the only thing missing is the "task box" header. Same shape Claude produces.
- **The "skip elaboration on HIGH+easy" path could miss subtle traps.** Mitigation: confirmation stage runs anyway when complexity is medium+; HIGH + easy is a narrow class (typos, single-file edits) where over-thinking is the bigger risk.
- **Race with Phase 15's preference inference** if both record memory entries simultaneously. Mitigation: existing memory-store dedup via SHA256 ID handles it; both phases use the same recorder.

## Implementation order

### Stage 1 — Complexity classifier pre-flight call
1. Split `completion-guard.ts` into pure `analyzeTaskComplexity` + post-hoc `validateCompletionAgainstComplexity` if not already done by Phase 16.
2. Wire pre-flight call after intent classification.
3. Stash result on run context.
4. Tests: pre-flight call site fires for every prompt; result is the right class.

### Stage 2 — Pre-task reasoning pipeline
1. Add `preTaskReasoningBriefSchema`.
2. New pipeline file with the Flash prompt.
3. Register in `task-reasoner.ts`.
4. Tests: pipeline produces the brief shape; routing trigger picks it up.

### Stage 3 — Task confirmation pipeline
1. Add `taskConfirmationBriefSchema`.
2. New pipeline file; takes the pre-task brief + memory `original_intent` + user prompt.
3. Register routing.
4. Tests: alignment matrix.

### Stage 4 — Orchestrator + skip-rules
1. Wire the gated chain in `user-message.ts` per the routing matrix in the goal section.
2. Skip-rules: simple → skip both; easy + HIGH → skip confirmation; medium/complex → both.
3. Wire `aligned: false` → existing `ask_user` / awareness modal path.
4. Tests: full routing matrix; flag-off path; ask-user escalation.

### Stage 5 — TaskPlan emission gating
1. Update `system-rules.ts` to make the taskPlan instruction conditional.
2. Server-side defensive guard in `base-provider.ts` to drop taskPlan when routing said skip.
3. Tests: simple prompt → no taskPlan in normalized response; implement+complex → taskPlan present.

### Stage 6 — KB docs + plan archive
1. `architecture.md` — pre-task reasoning subsection + updated chunked-loop diagram.
2. `decisions.md` — complexity moves pre-flight; the alternatives we rejected.
3. Plan archived to `applied/`.

## Verification

Per stage: typecheck + npm test green.

End-to-end:
- **Test 1 — simple Q&A skips pre-task entirely.** Prompt: `"what does this function do?"`; assert intent === simple, complexity === easy, no pre-task Flash call, no taskPlan in response.
- **Test 2 — complex implement runs both stages.** Prompt: `"build a postgres-backed user API with auth, sessions, audit log"`; assert pre-task brief + confirmation brief both produced; main model receives `whyThisApproach` + `aligned: true`.
- **Test 3 — borderline case escalates.** Prompt with mismatched stack signals; confirmation returns `aligned: false`; assert awareness modal fires before main model runs.
- **Test 4 — flag-off path identical to today.** `reasoning.pre_task_enabled = false`; rerun Test 2; assert no pre-task Flash, behaviour matches current.
- **Test 5 — taskPlan absent on summary intent.** Prompt: `"explain the auth service"`; intent === summary; assert no taskPlan in normalized response even when the model tried to produce one (defensive guard worked).
- **Test 6 — telemetry budget.** Across a representative free-tier complex run, assert `flashCallsCount` ≤ Phase 16's budget + 1 (one extra confirmation call).

## Out of scope

- Multi-step *agent* reasoning across turns. Phase 18 is per-turn.
- A user-visible "I'm thinking about why" indicator in the cli — that's Phase 14's `<ReasoningPeek>` already; pre-task briefs would surface through it naturally.
- Replacing the existing preflight pipelines. They stay; pre-task reasoning is a NEW stage that runs after intent classification + before the existing preflight call (or replaces it for free-tier complex cases — TBD during implementation).
- Tuning the complexity classifier for specific domains (web dev vs systems vs ML). Generic regex patterns stay; per-domain tuning is a future phase.
- Replacing taskPlan with something else. The shape stays; only its emission is gated.
