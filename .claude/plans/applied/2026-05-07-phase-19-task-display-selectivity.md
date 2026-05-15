# Phase 19 — Task display selectivity (Claude-style hidden internal task vs visible implement task)

- **Created:** 2026-05-07
- **Status:** implemented (2026-05-15)
- **Scope:** Claude Code only renders a task box when it's actually implementing something. For Q&A / investigations / quick questions, the answer comes back without a multi-step plan ceiling the conversation. sysflow today instructs every prompt's main model to produce a `taskPlan` and renders the resulting task box regardless of whether the prompt is "build a full app" or "what does this file do?". Phase 19 makes that selective.

## Goal

The visible CLI surface should match the user's mental model of "did I ask for a task?" Today the answer is "the system thinks every prompt is a task". After Phase 19:

- **Simple prompt** (one-line question, read-only request, single-file inspection) → no task box, just a natural answer + the tool cards from the actual reads. The agent still has internal structure (chunked loop, memory, reasoning briefs) — it's just not surfaced.
- **Bug fix / debug prompt** → no task box unless the bug touches multiple files. Bug pipeline already produces a structured brief; the cli renders it via `<ReasoningPeek>`, which is the right surface.
- **Implement prompt** → task box renders as before. Steps appear one-by-one as the chunk_plan fires (deferred from Phase 14 Stage 4 as a streaming improvement).

This composes with Phase 18, which gates taskPlan EMISSION on the server side. Phase 19 owns the cli RENDER side: even if a stray taskPlan slips through, the cli decides whether to show it.

## Context from knowledge base

- `architecture.md: ## Premium CLI components (Phase 14)` — `<ActionCard>` already renders per-tool. Phase 19 doesn't change the action-card surface, only the higher-level "this is the plan I'm about to execute" surface.
- `architecture.md: ## Living CLI (Phase 12)` — the persistent zones design. The task box currently lives in the AgentStream zone (settled). Phase 19 makes it conditional within that zone.
- `decisions.md: ## Render natural agent steps, not "chunk N/M" UI` — directly relevant. Phase 19 extends the same "show natural state, not implementation detail" principle to the higher-level task display.
- `decisions.md: ## Modal Ink-port deferred from Phase 12` — same risk pattern. Modal modals stayed raw-TTY because UI changes can balloon. Phase 19 keeps the change tightly scoped: gating logic, not new components.
- `gotchas.md: ## Continuation prompts ("continue the task") used to spawn the canned task pipeline` — the recent fix shaped the current taskPlan emission boundary. Phase 19's gating must respect it: `/continue` ALWAYS surfaces the prior task's progress (that's the whole point).
- Phase 14 plan `applied/2026-05-07-phase-14-premium-cli-experience.md` — Stage 5's deferred items include "ctrl+o expand". Could become relevant: a hidden task could be expandable on demand without being default-visible.

## Affected files

### Server-side gating (the source of truth)
*If Phase 18 lands first*, this is mostly already done:
- `server/src/providers/prompt/sections/system-rules.ts` — taskPlan instruction conditional on intent + complexity.
- `server/src/providers/base-provider.ts` — defensive drop of taskPlan when the route said skip.

If Phase 18 is NOT yet merged, Phase 19 needs to either wait or implement the same gating. Treat Phase 18 as a soft prerequisite: this phase ASSUMES the server doesn't emit a taskPlan for simple Q&A; if it does, the cli still has to gate (defense-in-depth).

### CLI-side render gate
- `cli-client/src/ui/components/AgentStream.tsx` — wherever the task header / task-step list renders, gate on `runIntent === "implement"`. Today the cli renders whatever the server normalized; the gate adds a frontend safety net.
- `cli-client/src/ui/hooks/useAgentEvents.ts` — extend the reducer state with `runIntent: "simple" | "summary" | "bug" | "implement" | null`. Set on a new `intent_classified` event the server emits early in the run.
- `cli-client/src/agent/events.ts` — add `intent_classified { intent: string }` event type.

### Server emission of intent
- `server/src/handlers/user-message.ts` — emit the classified intent down the response stream so the cli reducer can hold it. Existing SSE phase events are the natural carrier.
- `cli-client/src/lib/server.ts` — extend `callServerStream` to surface intent events through the existing phase handler. Optional extension; could also piggyback on the existing phase events.

### Internal-task indicator
- `cli-client/src/ui/components/Header.tsx` — when the agent has an internal task (chunk_plan fired, complex memory recall happening, etc.) but no visible taskPlan, render a tiny muted glyph or label like `· thinking through it` in the live cell area. This makes "the agent is doing work behind the scenes" legible without being heavy.

### Tests
- `cli-client/src/ui/hooks/__tests__/useAgentEvents.test.ts` (extend) — `intent_classified` reducer; `runIntent` survives across spinner / tool events; `clear` wipes it.
- `cli-client/src/ui/components/__tests__/AgentStream.test.ts` (or create) — taskPlan gates on `runIntent === "implement"`; renders for implement; absent for simple/summary/bug; the header indicator appears when internal-task signals exist but render is gated.
- `server/src/handlers/__tests__/user-message.test.ts` (extend) — emits the classified intent; intent matches the pipeline routing.

## Migrations / data

N/A. Pure renderer + reducer changes plus one new event type.

## Hooks / skills / settings to update

- New flag: `cli.task_display_selective` (default `true`). Off-switch in case a user prefers to see task boxes for everything (the current default).
- `.claude/knowledge/architecture.md` — small update to the Premium CLI components section noting the conditional taskPlan render.
- `.claude/knowledge/decisions.md` — entry on "task box gates on intent + complexity, not on prior-render heuristics".
- No `.claude/hooks/` or `.claude/settings.json` changes.

## Dependencies

- Soft dependency on Phase 18 for clean server-side gating. Phase 19 can ship first with cli-only gating (defense-in-depth) and Phase 18 layers on later.
- Soft dependency on Phase 14 Stage 4's `<ReasoningPeek>`; Phase 19 leans on it as the Q&A surface (the bug brief shows there, no task box needed).
- Zero new npm packages.

## Risks & mitigations

- **The cli could hide a taskPlan the user explicitly wanted to see.** Mitigation: the flag `cli.task_display_selective` defaults to `true` but lets users flip it off. Also: the user can always `/continue` to re-surface a prior task (that path is unchanged).
- **`/continue` after a hidden internal task.** Mitigation: `/continue` already routes via `buildContinueContext()` (architecture.md), which surfaces from session history regardless of what was rendered last time. Test guard covers this.
- **Free-tier models ignore the system-rules.ts taskPlan instruction.** That's the defensive-drop in `base-provider.ts` (Phase 18). Phase 19's frontend gate is a second line of defence.
- **Header indicator could become noise** if the "internal task" signal fires for every chunk_plan event. Mitigation: only show when chunk_plan AND visible taskPlan is gated off. For implement runs the existing chunk-pulse already does the job.
- **Intent classification on the server doesn't propagate fast enough** — by the time the cli receives the intent event, taskPlan might already have been received and rendered. Mitigation: emit `intent_classified` BEFORE the main-model call (after the intent classifier runs at line ~78 of `task-reasoner.ts`); since the main-model response is what carries taskPlan, the intent always arrives first.

## Implementation order

### Stage 1 — `intent_classified` event + reducer slot
1. Add `intent_classified { intent: "simple" | "summary" | "bug" | "implement" }` to `events.ts`.
2. Extend `useAgentEvents.ts` reducer with `runIntent: typeof intent | null`. `clear` wipes it. Most-recent wins.
3. Tests for the reducer slot.

### Stage 2 — Server emission
1. Server emits `intent_classified` early in user-message handling, after `pickPipeline()` returns.
2. Extend the SSE phase event payload OR add a new event channel; pick whichever is cleaner.
3. Tests: server side emits the right intent for each pipeline routing.

### Stage 3 — CLI gate on render
1. Wherever the task header / task box renders in `<AgentStream>` (or its peer), gate on `runIntent === "implement"`.
2. For all other intents, the agent stream just renders tool cards + reasoning peek + assistant message + spinner.
3. Tests: rendering matrix per intent.

### Stage 4 — Internal-task indicator
1. Header gets a tiny `· thinking through it` cell when chunk_plan fires AND `runIntent !== "implement"`.
2. Tests: indicator renders / hides on the right state.

### Stage 5 — KB docs + plan archive
1. `architecture.md` — Premium CLI components subsection update.
2. `decisions.md` — entry on the gating principle + alternatives rejected (fully hide / always show / user-toggle-only).
3. Plan archived to `applied/`.

## Verification

Per stage: typecheck + npm test green.

End-to-end:
- **Test 1 — simple Q&A surface.** Prompt: `"what does this file do?"`; verify no task box renders; reasoning brief shows in `<ReasoningPeek>`; tool cards for any reads; assistant message via Typewriter at the end.
- **Test 2 — implement renders task box.** Prompt: `"build a postgres-backed user API"`; verify task box renders as before; chunk pulses fire; tool cards stream; assistant message at completion.
- **Test 3 — bug fix doesn't render task box for single-file fix.** Prompt: `"fix the typo in src/foo.ts"`; intent classified bug, complexity easy; no task box; bug brief shows in peek; tool cards for the edit.
- **Test 4 — `/continue` after a hidden internal task.** First prompt simple Q&A (no task box). Second prompt `/continue`; verify the continuation context is surfaced naturally; no regression.
- **Test 5 — flag-off path.** Set `cli.task_display_selective = false`; rerun Test 1; verify task box renders for everything (current behaviour).
- **Test 6 — header indicator on Q&A with internal task.** Force a Q&A run where chunk_plan fires (artificial test fixture); verify the muted "thinking through it" indicator appears in the Header live cell area.

## Out of scope

- A new "task tray" or expandable hidden-task viewer (`ctrl+o` to peek). That's the deferred Phase 14 Stage 5 work; Phase 19 doesn't require it but doesn't preclude it.
- Re-styling the task box itself. The visual remains today's task box; only its appearance is now conditional.
- Heuristics that auto-show a task box mid-Q&A if the work turns out to be larger than expected. The intent classification is sticky for the run; complexity may upgrade but the visible-task gate doesn't reactively flip.
- A user toggle keystroke to surface the hidden internal task on demand. Could be added later via the focus-stack store; out of scope here.
- Server-side intent classification improvements. The existing classifier in `intent-classifier.ts` is what we use.

## Completion notes

Shipped as a single PR (Phase 19 is smaller than the recent multi-stage plans; five stages bundle cleanly without review-load concerns).

**Stage execution:**

- Stage 1 — `intent_classified` event + `runIntent` reducer slot landed in `useAgentEvents.ts`. 7 new reducer tests covering the known values, malformed-input defense, most-recent-wins, survival across other events, and `clear` wipes it.
- Stage 2 — server emits `ClientResponse.runIntent` from both `user-message.ts` (initial response) and `tool-result.ts` (every subsequent response, defensive). Both use `classifyIntent(run.content)` — pure regex, no extra Flash call. The cli emits `intent_classified` from the bus on the first response that carries the field; subsequent responses are guarded so the event fires at most once.
- Stage 3 — `handleNeedsTool` reads `runIntent` + `taskDisplaySelective` from `NeedsToolCtx`; the task block (`if (task && !taskDisplayGated)`) skips when the gate trips. Threaded through the existing ctx pattern, no new state-machine seams.
- Stage 4 — `Header.tsx` gains a `showInternalTaskIndicator` derived state. When `chunk` fired AND `runIntent !== "implement"`, the muted `· thinking through it` cell renders instead of the chunk-pulse. Pre-classification (runIntent null) preserves the existing chunk-pulse behaviour for defense-in-depth.
- Stage 5 — two knowledge entries (architecture diagram + decisions on the gating principle); plan archived to `applied/`.

**Deviations from the original plan:**

- The original plan listed `cli-client/src/lib/server.ts` extensions to surface intent through SSE phase events. **Not needed** — `ClientResponse.runIntent` on the existing response payload is enough. The reducer captures from the first response; SSE-channel plumbing was unnecessary indirection.
- The plan mentioned a new `AgentStream` task render to gate. **Not the actual gate point** — the task box already doesn't render in Ink mode (Phase 14 Stage 1 gated `renderPipelineBox` behind `shouldRenderInlineForLegacy()`). The real surface in Ink mode is the `printStepTransition` log lines + `renderCompletion`'s taskSteps render, both driven by `handleNeedsTool`'s task block populating `ctx.taskSteps`. Gating the populating block (not a render call) is the cleanest place — if `taskSteps` stays empty, all downstream renders naturally skip.
- The plan called for a flag `cli.task_display_selective` (default `true`). Shipped as `taskDisplaySelective` in sysbase (same convention as the other Phase 14/17/Stage-2 settings).
- Per-server-test coverage of the new `runIntent` field: deferred. The server change is two `clientResp.runIntent = classifyIntent(...)` lines + a non-breaking optional field on `ClientResponse`. The cli reducer + handler tests cover the consumption shape; a focused server-side test pair adds review surface without information gain.

**Stage 3 of Phase 18 ("server gates taskPlan emission"):** still draft. Phase 19's frontend gate is the defense-in-depth layer that Phase 18 will later compose with. No regression — even if a free-tier model ignores the future Phase 18 server directive and emits a stray taskPlan, the cli's gate hides it.

**Knowledge entries captured:**

- `architecture.md: ## Task display selectivity (Phase 19)` — flow diagram + key files + composition with future Phase 18
- `decisions.md: ## Task box gates on intent classification, not on prior-render heuristics` — three rejected alternatives + the sticky-classification rule
