# Phase 11 — Awareness & adaptive recovery loop

- **Created:** 2026-05-06
- **Status:** draft
- **Scope:** Detect when the agent is executing a wrong plan (especially on free models) and either auto-correct mid-run or hand the wheel back to the user before more wrong work piles up.

## Goal

The agent today commits to a direction at chunk 1 and rides it to the end, even when the file system, tool errors, or the user's literal ask have already diverged from that direction. Phase 10 catches *micro* errors per chunk ("import didn't resolve"); Phase 11 catches *macro* errors across chunks ("you've been building Express + MongoDB but the user said Postgres", "you've created 8 controller files and zero routes that use them"). The system answers two questions every couple of chunks — *am I still solving the user's actual ask?* and *do my files actually work?* — and surfaces an Ink-style auto-pause modal with continue / backtrack / redirect options when confidence drops.

## Context from knowledge base

No `.claude/knowledge/` directory yet. Cited priors (plans on disk):

- `.claude/plans/applied/2026-05-02-phase-7-background-jobs.md` — established the git-snapshot infrastructure (`createSnapshot` / `rollback`) Phase 11's *backtrack* action reuses. Single-snapshot-per-run today; Phase 11 grows it into a per-chunk queue.
- `.claude/plans/applied/2026-05-02-phase-5-pre-flight-reasoning.md` — same Zod envelope + sha256 cache + Gemini Flash callsite Phase 11's divergence detector hangs off.
- `.claude/plans/2026-05-02-phase-8-persistent-reasoning-memory.md` — the `.sysflow-memory.md` recorder Phase 11 adds an `original_intent` kind to.
- `.claude/plans/2026-05-06-phase-10-chunked-reasoning-loop.md` — **dependency**. Phase 10's chunk-state + chunk-reflector are the seams Phase 11 plugs into. Phase 11 assumes Phase 10 has landed.

## Affected files

### New modules
- `server/src/services/divergence-detector.ts` — heuristic + LLM-backed signals. Pure function over a `DetectorInput` (run history + chunk-state + tool errors + user prompt). Returns `{ score: 0-100, signals: DivergenceSignal[], llmVerdict?: LlmVerdict }`. Heuristic-only by default; LLM call gated on heuristic firing OR every 2nd chunk.
- `server/src/services/confidence-tracker.ts` — per-run confidence score, decay rules, weight table. Exposes `recordSignals(runId, signals[])` + `getConfidence(runId)` + `getThresholdState(runId)` (returns `'on_track' | 'off_course' | 'blocked'`).
- `server/src/services/verification-gate.ts` — ground-truth checks that don't need an LLM. Extends `cli-client/src/agent/verifier.ts`'s checks (run client-side via tool dispatch) with: import-resolves, package.json deps cross-check, `node --check` syntax-only, dir-emptiness audit. Each check is a pluggable `VerificationCheck` interface so we can grow it later.
- `cli-client/src/cli/off-course-prompt.ts` — raw-TTY modal mirroring `cli-client/src/cli/permission-prompt.ts:103-254`. Three keys: `c` continue, `b` backtrack, `r` redirect. Renders the divergence evidence (top 3 signals) inline before the keys.
- `server/src/reasoning/pipelines/divergence-pipeline.ts` — the LLM half of the detector. Tight system prompt + `DivergenceVerdictBrief` schema (`{ onTrack: bool, score: 0-100, mismatches: string[], suggestion: 'continue'|'pause'|'backtrack', confidence }`).

### Extended modules
- `cli-client/src/agent/git.ts:38-49` — promote `Map<runId, GitSnapshot>` to `Map<runId, GitSnapshot[]>` (snapshot queue per chunk). New `createChunkSnapshot(cwd, runId, chunkIndex)`, `listSnapshots(runId)`, `rollbackToChunk(cwd, runId, chunkIndex)`. Existing `createSnapshot/rollback` keep working as "latest" sugar so Phase 7's callers don't change.
- `server/src/services/context-manager.ts:41-56` — extend `WorkingContext` with `divergenceState: { score: number; signals: DivergenceSignal[]; lastCheckedChunk: number }`. Initialised in `initRunContext`.
- `server/src/memory-store/entry-schema.ts:15` — add `"original_intent"` to the kind enum. Tiny.
- `server/src/memory-store/recorder.ts:48-114` — add `recordOriginalIntent(cwd, verbatimPrompt, sourceRef)` following the same `safeRecord()` pattern. Called once on the first turn of every new run.
- `server/src/reasoning/task-reasoner.ts:121-128` — `pickPipeline()` accepts new trigger `"divergence_check"` routing to the divergence pipeline.
- `server/src/reasoning/reasoning-schema.ts:124-157` — add `divergenceVerdictBrief?` to envelope; extend `assertEnvelopeShape()` to handle the new pipeline kind.
- `server/src/handlers/tool-result.ts` (Phase 10 seam) — after Phase 10's chunk-reflector + before chunk-planner: run `verification-gate` (parallel ground-truth checks) → run heuristic divergence detector → on heuristic fire OR every-2nd-chunk run LLM divergence pipeline → record signals into confidence-tracker → if `getThresholdState === 'blocked'`, short-circuit with a `waiting_for_user` response carrying the divergence evidence. Otherwise pass `confidenceState` into chunk-planner so it can switch strategy.
- `server/src/handlers/user-message.ts` — record `original_intent` into memory on the first turn of a fresh run.
- `cli-client/src/agent/agent.ts` — handle `waiting_for_user` from divergence: stop the spinner, render the off-course modal, route the user's choice back as a new tool result (`_user_response` with `{ action: 'continue' | 'backtrack' | 'redirect', text? }`).
- `cli-client/src/cli/render.ts` — new `renderConfidenceBadge(state)` (✓ on track / ⚠ off course / ✖ blocked) shown in the status line + chunk-progress box.
- `cli-client/src/agent/usage-log.ts:12-28` — extend `RunSummary` with `divergenceDetections?: number`, `divergenceConfidenceAvg?: number`, `autoPauseEvents?: number`. Optional → backward-compatible.
- `server/src/services/flags.ts` — three flags: `awareness.enabled` (default `false`), `awareness.threshold_off_course` (default `60`), `awareness.threshold_blocked` (default `30`). Plus a model-aware override: when `model` matches `openrouter-auto|llama|mistral|gemini-flash-or`, both thresholds rise by 10 (more sensitive on free models).

### Tests
- `server/src/services/__tests__/divergence-detector.test.ts` — heuristic table tests for each signal class.
- `server/src/services/__tests__/confidence-tracker.test.ts` — score decay + threshold transitions.
- `server/src/services/__tests__/verification-gate.test.ts` — synthesised file fixtures for each check type.
- `server/src/reasoning/__tests__/divergence-pipeline.test.ts` — fixture brief parses, off-shape briefs reject.
- Manual fixture: `server/src/reasoning/__tests__/fixtures/wrong-stack-run.json` — replay-able run snapshot where the agent went down the wrong path; assert detector flags it.

## Migrations / data

N/A. Per-run state is in-memory. Memory store gets a new kind value but the markdown format is append-only — no migration. Git snapshot queue is in-memory.

## Hooks / skills / settings to update

- No `.claude/hooks/` changes.
- `.claude/knowledge/decisions.md` (post-implementation) — record the `additive vs merged` choice (we picked additive: detector runs ALONGSIDE Phase 10's reflector, not merged into one Flash call) and *why* — separation of concerns + cheaper to disable one without the other.
- `.claude/knowledge/architecture.md` (post-implementation) — extend Phase 10's flow diagram with the detector + verification-gate parallel branch.

## Dependencies

- No new npm packages.
- No new env vars.
- Increased Flash quota: roughly 1 extra Flash call per 2 chunks (the detector LLM half), so ~+50% over Phase 10's chunk-loop = ≤ 1.5× target met.
- Reuses Phase 7's git infrastructure, Phase 10's chunk-state, Phase 8's memory recorder.

## Risks & mitigations

- **False positives** — detector flags "off course" when the agent is actually fine. Free models on a complex prompt look weird-but-correct often. Mitigation: confidence is a SCORE not a boolean; only flag when score < `awareness.threshold_blocked` AND ≥2 signals fire. Heuristics-only by default; LLM only confirms.
- **False negatives** — agent really is off course but we miss it. Mitigation: 5 independent heuristic categories; LLM second-opinion every 2nd chunk; original-prompt anchor catches scope drift; the reflector from Phase 10 is independent and runs every chunk.
- **Auto-pause modal feels intrusive** — user is in flow, modal interrupts. Mitigation: only triggers at the `blocked` threshold (default 30); `off_course` (60) just adds a yellow `⚠` to the status line and surfaces signals on the next chunk-progress render. User can tune thresholds via flags.
- **Backtrack rolls back too much (or too little)** — single-snapshot Phase 7 model can't target a specific chunk. Mitigation: Stage 2 extends `git.ts` to a per-chunk snapshot queue. Modal lets the user pick which chunk to roll back to (default = last good chunk per detector).
- **Free Gemini Flash quota** — divergence LLM half adds calls. Mitigation: heuristic-only mode (no Flash) always available via `awareness.detector_mode=heuristic_only` flag. Cache divergence verdicts by `(runId, signals-hash)`.
- **Detector ↔ chunk-planner conflict** — detector says "blocked", planner says "carry on". Mitigation: detector's verdict is authoritative for the loop; planner sees it as input, can't override. If detector says blocked, the loop halts before the planner is even consulted.
- **`continue the task` after a redirect re-fires the detector immediately** — annoying. Mitigation: set a `divergenceCooldownChunks` of 2 after a user-resolved auto-pause; detector skipped during the cooldown.
- **Test brittleness** — heuristics are tuneable numbers, easy to over-fit. Mitigation: every weight is a constant in one file with comments explaining the rationale; threshold flags exposed for live tuning.

## Implementation order

Each stage is its own PR. Stages 1-3 are foundation (no user-visible behaviour); Stage 4 is the first user-visible turn-on; Stages 5-7 polish + observability.

### Stage 1 — Heuristic detector + confidence tracker (no LLM)
1. `divergence-detector.ts` — implement the 6 heuristic signals: same-file-edited-N-times, repeated-tool-error-class, mkdir-empty-at-chunk-boundary, completion-claims-files-but-disk-empty, intent-keyword-absent (extract user-prompt nouns; check none of them appear in the implementation), scope-creep (chunk count > planned).
2. `confidence-tracker.ts` — per-run map, decay table (each signal weighted), threshold transitions.
3. `flags.ts` — `awareness.enabled` (default `false`), thresholds.
4. Wire into Phase 10's tool-result seam (heuristic-only path; no Flash yet).
5. Tests for both modules. **Behaviour: nothing changes for users; data is recorded but not acted on.**

### Stage 2 — Verification gate + per-chunk snapshots
1. `verification-gate.ts` — implement the 4 ground-truth checks (import-resolves, deps-cross-check, node-syntax-check, dir-emptiness audit). Each check is async, parallelisable, completes <1s. Feeds signals into the detector.
2. `git.ts` extension — `Map<runId, GitSnapshot[]>` queue + new `createChunkSnapshot` / `listSnapshots` / `rollbackToChunk` API. Old `createSnapshot/rollback` become "queue-tail" sugar.
3. Wire chunk-snapshot creation into Phase 10's chunk-state on each chunk start.
4. Tests + fixture for each verification check.

### Stage 3 — LLM divergence pipeline + original-intent memory
1. `pipelines/divergence-pipeline.ts` — system prompt + brief schema.
2. `task-reasoner.ts` — accept new trigger.
3. `reasoning-schema.ts` — extend envelope.
4. `memory-store/entry-schema.ts` + `recorder.ts` — add `original_intent` kind + `recordOriginalIntent`.
5. `user-message.ts` — record original intent on every new run.
6. Wire LLM-half of detector — fires when heuristics flag OR every 2nd chunk. Result merged into confidence-tracker.

### Stage 4 — Off-course modal + first user-visible turn-on
1. `off-course-prompt.ts` — raw-TTY modal mirroring permission-prompt. Three keys + inline evidence.
2. `agent.ts` — handle `waiting_for_user` from divergence-blocked; render modal; route user choice back.
3. Server-side handler for the user's choice (`_user_response` with action). Backtrack invokes `rollbackToChunk(lastGoodChunk)` then re-prompts; redirect treats user's text as a new `user_message` with the run's history pre-pruned to the last good chunk.
4. Flip `awareness.enabled` flag default `false` → `true`. **First user-visible win.**

### Stage 5 — Confidence badge + chunk-UI integration
1. `render.ts` — `renderConfidenceBadge(state)` showing ✓ / ⚠ / ✖.
2. Status line gets the badge alongside model + user.
3. Phase 10's chunk-progress box shows the current confidence + last detected signals (one-line) when ⚠+ state.

### Stage 6 — Telemetry + caching
1. `usage-log.ts` extension — record divergence metrics per run.
2. Detector verdicts cached by `(runId, signals-hash)` via existing reasoning-cache module.
3. Cooldown after user-resolved auto-pause (2 chunks) to prevent immediate re-fire on `/continue`.

### Stage 7 — Documentation + free-model tuning
1. Free-model threshold override (+10 sensitivity) when model matches `openrouter-auto|llama|mistral|gemini-flash-or`.
2. `.claude/knowledge/architecture.md` — diagram extension.
3. `.claude/knowledge/decisions.md` — record the additive-vs-merged decision.
4. `.claude/knowledge/gotchas.md` — write up the symptoms (wrong stack ridden to the end, scope creep, etc.) so future contributors see why this exists.

## Verification

Per stage:
- `npm run typecheck` clean
- `npm test` — existing tests pass; new module tests added per stage.

End-to-end (after Stage 4):
- **Test 1 — wrong-stack scenario**: prompt *"build a postgres-backed user API"*, manually nudge the model into MongoDB by injecting a mock chunk-plan that uses Mongoose. Detector should flag `intent-keyword-absent` (no `pg`/`postgres` imports) within 2 chunks; confidence drops to `blocked`; modal appears with the divergence evidence; backtrack rolls back to chunk-0 snapshot.
- **Test 2 — empty-dir scenario**: prompt *"build an express backend with controllers and models"*, let the model run normally. If completion-claims-files-but-disk-empty fires (the original Symptom #1 the user flagged), confidence drops, modal appears.
- **Test 3 — false-positive guard**: prompt *"add a logout endpoint"* (small task). Detector should NOT fire; confidence stays at 100; user sees no modal.
- **Test 4 — backtrack roundtrip**: trigger the modal, choose backtrack-to-chunk-1, agent restarts from there with prior chunks reverted. Verify file system matches snapshot.
- **Test 5 — redirect**: trigger the modal, choose redirect, type *"actually use postgres not mongo"*. Agent restarts from last good chunk with the new direction; first new chunk-plan reflects the corrected stack.

Metrics to watch (Stage 6):
- Detector firing rate per run (target: ≤ 0.3 per implement run on average)
- Auto-pause rate (target: ≤ 0.1 per run; higher on free models)
- False-positive rate (manual review of first 20 production fires) — target: ≤ 20%
- Mean confidence at run end (target: ≥ 70 on completed runs)

## Out of scope

- Auto-fixing detected divergences without user input — too risky, easy to compound the wrong direction further.
- Full backtrack-and-replan automation — manual user override is enough for v1; auto-recovery is Phase 12 if metrics show it's wanted.
- Cross-run divergence learning (memory of "this user always means Postgres when they say DB") — Phase 12.
- Multi-turn conversational backtrack ("which chunk should I roll back to?" with the model proposing) — v1 lets the user pick from a list.
- Detection on read-only / summary intents — those don't have chunks; nothing to verify.

## Foundation iteration policy

Phase 11 leans hard on the reasoning + memory systems Phase 10 just stretched. **If implementation reveals a foundation gap, fix the foundation, not the symptom.** Likely places this phase will surface gaps:

- The reasoning envelope needs another discriminated case (`divergenceVerdictBrief`) — extend the schema, don't side-channel through an opaque blob.
- The reasoning cache key needs to factor in run state (signal hash) — extend `reasoning-cache.ts` rather than caching outside it.
- Memory recorder needs a new kind (`original_intent`) and probably a new validator (verbatim prompts shouldn't trigger the secrets filter on words like "password" in user requests like "build a password-reset flow") — fix the validator, don't bypass.
- Confidence tracker becomes a peer of `task-pipeline.ts` and `chunk-state.ts`; if all three end up with similar shape, factor a shared per-run-state helper.
- Off-course modal duplicates permission-prompt structure; if true, factor a shared raw-TTY single-keystroke modal primitive.

These count as in-scope foundation work for whichever stage surfaces the gap. Out-of-scope is anything that's *not* a downstream consequence of this phase's load (e.g. don't redo the memory file format here just because we're adding `original_intent`).

## Composition with Phase 10 (additive, not merged)

Phase 10 reflector and Phase 11 detector run as **two separate Flash calls**, not merged into one. Reasons:

1. **Different concerns.** Reflector validates THIS chunk ("did the writes I just made compile and cohere?"). Detector validates THE WHOLE RUN ("am I still solving the user's actual ask?"). Merging them dilutes both.
2. **Different cadence.** Reflector runs every chunk; detector runs every 2nd chunk OR on heuristic fire. Merging forces both to run at the higher frequency, doubling cost.
3. **Different failure modes.** A chunk can be coherent (reflector ✓) but the run is wrong (detector ✗). And vice versa — a chunk can have a broken import (reflector ✗) on a correctly-aimed run (detector ✓). Treating them as one signal loses the distinction.
4. **Different kill switches.** `awareness.enabled = false` should not disable Phase 10's reflector and vice versa. Independent flags.

The order at every chunk boundary:

```
chunk N executes →
verification-gate (ground truth, parallel, <1s) →
chunk-reflector (Phase 10, Flash, ~400 tok) →
divergence-detector heuristic (instant) →
[if heuristic fires OR chunk N % 2 == 0] divergence-detector LLM (Flash, ~300 tok) →
confidence-tracker.recordSignals(...) →
[if blocked] off-course modal → user choice →
chunk-planner (Phase 10, Flash, ~500 tok, with `confidenceState` injected) →
chunk N+1 executes
```
