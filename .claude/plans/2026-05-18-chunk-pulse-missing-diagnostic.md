# Chunk pulse missing on implement runs — diagnostic + fix

- **Created:** 2026-05-18
- **Status:** in-progress
- **Scope:** Visible bug from 2026-05-18 user testing — the Header's chunk-pulse cell (`▸ N`) never rendered during a clear implement-class scaffold run (Express POS backend), even though `chunk_plan` events SHOULD have fired multiple times.

## Goal

User trace excerpts (2026-05-18, Express scaffold):

```
sys v0.1  test  ·  openrouter-auto  ·  no chat  ·  admin  ·  ⚠  68 (...)

sys v0.1  test  ·  openrouter-auto  ·  no chat  ·  admin  ·  ✔ 100
```

Across multiple turns spanning ~7 chunk-plan firings on what's CLEARLY an `implement`-class run (POS backend scaffold), the Header NEVER showed `▸ 1` / `▸ 2` / etc. The chunk-pulse cell was absent entirely.

Per Stage 5 of the UI/UX polish plan, `chunkRenderMode(chunkPresent, runIntent)` returns:

- `"implement-pulse"` when `chunkPresent === true && (runIntent === "implement" || runIntent === null)`
- `"internal-indicator"` when `chunkPresent && runIntent !== "implement"` AND classified
- `"hidden"` when `!chunkPresent`

So for the pulse to be missing, either:

- **(a)** `chunk` state is `null` in the reducer — the `chunk_plan` event never fired OR never made it through the reducer.
- **(b)** `runIntent` is set to a non-`implement` value — but then we'd see the `internal-indicator` muted "thinking through it" cell. The trace doesn't show that either, so `runIntent` is likely null OR the indicator is somehow suppressed.

## Context from knowledge base

- `architecture.md: ## Living CLI (Phase 12)` — `<Header>` chunk-pulse cell.
- `architecture.md: ## Task display selectivity (Phase 19)` — runIntent gating on the task box. Chunk-pulse is independently gated.
- `applied/2026-05-18-ui-ux-polish-and-action-aware-spinner.md` Stage 5 issue #8 — `chunkRenderMode` exhaustive helper.
- `cli-client/src/agent/events.ts: chunk_plan` event type — fired by `agent.ts` when a server response carries `chunkPlanBrief`.

## Affected files

- `cli-client/src/agent/agent.ts` — where `chunk_plan` events are emitted. Audit: which response paths emit, which skip.
- `cli-client/src/ui/hooks/useAgentEvents.ts: reduceAgentEvent` `chunk_plan` case — verify it's still wired correctly.
- `cli-client/src/ui/components/Header.tsx` — render path; double-check the `chunkRenderMode` helper actually drives the JSX (verified in Stage 5 but re-confirm against trace).

## Implementation order

### Stage 1 — Diagnose

Add temporary diagnostic logging:

1. In `agent.ts`, log `[chunk-plan-emit] chunkIndex=N nextAction="..."` every time `emitAgent({type: "chunk_plan", ...})` fires.
2. In `Header.tsx`, log `[header-render] chunk=${chunk?.index ?? null} runIntent=${runIntent} mode=${chunkMode}` on every render (debounced to once per chunk change to avoid spam).
3. Reproduce the user's scaffold prompt. Capture both log lines AND the rendered Header.

Three branches based on diagnostic findings:

- **(a) Emit never fires:** the cli's response-handling code doesn't observe `chunkPlanBrief` on the response. Likely root cause: response field renamed server-side, or the agent.ts observation path was added pre-Phase-19 and not updated for new response shapes.
- **(b) Emit fires but reducer doesn't store:** `chunk` slot stays null. Likely root cause: event payload shape mismatch with the reducer's type guard.
- **(c) Reducer stores chunk but Header renders `hidden`:** `chunkRenderMode` is returning `"hidden"` despite chunk being non-null. Likely: a regression in the helper's logic.

### Stage 2 — Fix per branch

Branch-specific fixes once the diagnostic localises the root cause:

- **(a)** Update agent.ts response observation to match current server response shape. Tests pinning the observation path.
- **(b)** Reducer payload guard fix. Tests for the corrected shape.
- **(c)** Helper logic fix. Tests for the regression case.

### Stage 3 — Remove diagnostic logs + add a defensive integration test

- Remove the temporary `[chunk-plan-emit]` + `[header-render]` console logs.
- Add a defensive integration test: reduce a sequence of `chunk_plan` + `intent_classified` events; assert `chunkRenderMode` returns `"implement-pulse"` and the Header's expected rendering shape includes the `▸ N` text.

## Verification

- **Stage 1:** diagnostic log surfaces the root cause branch.
- **Stage 2:** branch-specific unit test passes.
- **Stage 3:** integration test pins the contract. Manual: re-run the user's Express scaffold. Observe `▸ 1` / `▸ 2` etc. appear in the Header as the chunks plan.

## Out of scope

- Replacing the chunk-pulse with a different visual. Phase 12 design stands.
- Adjusting `runIntent` classification semantics. If the run was misclassified, that's a separate intent-classification fix.
- Persisting chunk index across run restarts. Each fresh prompt starts at chunk 1.

## Why diagnostic-first

The fix is small but the cause space is wide. Shipping a "fix" without first narrowing branch (a/b/c) risks fixing the wrong thing. The Stage 1 logs are deletable and cost ~10 lines; well worth it to land the right fix.
