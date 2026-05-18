# Chunk pulse missing on implement runs — diagnostic + fix

- **Created:** 2026-05-18
- **Status:** implemented (2026-05-18)
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

## Completion notes

Shipped across PRs #137 (Stage 1 diagnostic), #138 (Stage 2 integration test + helper extraction), and this PR (Stage 3 root-cause fix + log cleanup).

**Stage 1 (#137)** added `[chunk-pulse-diag]` console logs at: initial-response observation, initial emit gate + emit, per-turn response observation, per-turn emit gate + emit, and Header render (debounced via useRef). No behaviour change.

**Stage 2 (#138)** extracted the cli's emit decision into a pure helper `chunkPlanEventFromResponse(response, chunkIndex, inkActive)` and wired both observer sites through it. Added 10 integration tests walking the full chain (server response shape → event extraction → reducer → render mode). All 10 passed, definitively ruling out branches (b) reducer-payload-mismatch and (c) chunkRenderMode-regression.

**Stage 3 (this PR)** — the user's diagnostic-test trace from PR #137 surfaced branch (a) confirmed: `chunkPlanBrief=absent` on every turn (initial + per-turn). Root cause turned out to be two server-side bugs interacting:

1. **Chunk-plan pipeline gate too aggressive.** `user-message.ts:503` skipped the chunked-loop entirely when the preflight reasoning brief's `implementBrief.buildPlan` had ≤3 high-level steps (`isTrivial` shortcut). For scaffold-class prompts ("build Express POS with Postgres") the buildPlan summary is 2-3 bullets but expands to 15-25 files. With chunked-loop skipped, `recordChunkStart` never fires → `activeChunks === 0` → `tool-result.ts` chunked-loop block never runs → no `chunkPlanBrief` ever attached. Fix: tighten threshold from `≤3` to `=1`. Real "trivial" is a single-step plan; 2-3 steps deserve chunked structure.
2. **Tool-result `args` not threaded cli→server.** Bonus bug surfaced during Stage 3 investigation: `tool-result.ts` was calling `ingestToolResult(body.runId, body.tool, body.result, body.result)` — passing `body.result` for BOTH the args param AND the result param. Worked accidentally for tools whose result echoed back `path` (e.g. write_file at executor.ts:263) but failed for `args.content` which is never echoed. This broke the structural-signal check in the divergence detector — package.json content wasn't captured into `contentSnippets`, so `intent_keyword_absent: express` fired falsely even after the agent wrote a package.json with `"express"` in deps. Fix: add optional `args` field to `ToolResultBody` (and `toolResults[].args` for batch); cli builds an `argsById` map at payload construction and enriches each result entry; server call sites use `body.args ?? body.result` (fallback preserves back-compat for older cli builds).

Stage 3 also removed the temporary `[chunk-pulse-diag]` logs from Stage 1.

Plan 4 closes the four 2026-05-18 visible-bug plans (#1 off-course modal display, #2 batch heading + permission label, #3 awareness heuristic accuracy, #4 chunk pulse missing).

Tests added in Stage 3:
- `server/src/handlers/__tests__/tool-result-args-threading.test.ts` — 5 tests pinning the new args-selection contract + user-repro (express + postgres deps in package.json satisfy structural signal).
- Existing 5 tests for `classify402Terminal` already pin the OpenRouter side; Plan 4 doesn't touch it.
