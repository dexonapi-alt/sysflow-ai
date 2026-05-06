# Phase 10 — Chunked reasoning loop

- **Created:** 2026-05-06
- **Status:** in-progress
- **Scope:** Replace the run-level `preflight reason → bulk turn` flow with a per-chunk `plan → execute → reflect → plan` loop driven by Gemini Flash, so the main model emits small focused chunks instead of one mega-response.

## Goal

Make the agent reason **and adapt** at every step instead of once per run. Two new cheap Gemini Flash calls (chunk-planner + chunk-reflector) bracket every main-model turn — the planner says *"next chunk: write models X/Y/Z"* before the model executes, the reflector observes what landed on disk after.

Three benefits, in priority order:

1. **Adaptivity.** Today the agent commits to one plan at run start and rides it to the end, even when the file system has diverged. With per-chunk reflection the reflector reads the actual diff + tool errors before each new plan — *"server.js imports `./db` but you wrote `./database` in the last chunk; next chunk fixes the import"*. Course-correction stops being something the user has to prompt for.
2. **Quality.** No 30k-token uninterrupted bulk. The model can't cruise past a wrong decision because something checks every ~2-3 minutes of model output.
3. **Cost.** Each main-model turn fits under free-tier OpenRouter affordability without preemptive capping; the memory + reasoning system gets exercised per chunk, so cached plans amortise across similar work.

## Context from knowledge base

No `.claude/knowledge/` files exist yet — Phase 5 + Phase 8 plans are the closest priors:

- `.claude/plans/applied/2026-05-02-phase-5-pre-flight-reasoning.md` — established the four-trigger / four-pipeline reasoning architecture this builds on. Same Zod envelope + sha256 cache + Gemini Flash callsite.
- `.claude/plans/2026-05-02-phase-8-persistent-reasoning-memory.md` — the `.sysflow-memory.md` recorder Phase 10 will write `chunk_summary` entries into.
- `server/src/providers/prompt/sections/task-guidelines.ts` — `CHUNKING` block from PR #14 told the agent to self-manage chunks; Phase 10 replaces self-management with planner-driven chunks.

## Affected files

### Reasoning core (server/src/reasoning/)
- `reasoning-schema.ts:124-157` — extend `pipeline` enum with `chunk_plan` + `chunk_reflect`; add `chunkPlanBrief?` + `chunkReflectionBrief?` fields to envelope; teach `assertEnvelopeShape()` the new exact-one-match cases.
- `task-reasoner.ts:121-128` — `pickPipeline()` gets two new triggers (`"chunk_plan"`, `"chunk_reflect"`) that route directly to the matching pipeline (no intent classifier). `runReasoningInner` flow (cache + model call + parse) is reused as-is.
- `pipelines/index.ts:11-20` — extend `PipelineKind` and the `getPipelineSystemPrompt()` switch.
- `pipelines/chunk-plan-pipeline.ts` — NEW. System prompt + Zod brief shape. Constrains output to `{ nextAction, files: string[], rationale, dependencies, expectedSizeBin: 'tiny'|'small'|'medium'|'large', confidence }`.
- `pipelines/chunk-reflector-pipeline.ts` — NEW. System prompt + Zod brief shape. Constrains output to `{ coherent: bool, issues: string[], nextFocus: string, shouldStop: bool, confidence }`.

### Handlers (server/src/handlers/)
- `user-message.ts:207-248` — after preflight reasoning resolves, when `decision === "proceed"` AND chunked-loop flag is on, fire the **first** `chunk_plan` call. Stash result on `clientResp.chunkPlanBrief` (parallel to `reasoningBrief`).
- `tool-result.ts:217-350` — per-turn seam. After tool results are ingested but before `callModelAdapter()`, fire `chunk_reflect` (input = tool results + diff stats from this turn) → then `chunk_plan` (input = preflight brief + chunk-state + last reflection). Inject both briefs into `providerPayload` so the next model call sees the planner's nextAction.

### State + memory
- `services/chunk-state.ts` — NEW per-run map. Exports: `recordChunkBoundary(runId, plan, executedFiles, reflection)`, `getChunkHistory(runId)`, `chunkCount(runId)`, `clearChunkState(runId)`. Pure in-memory like `task-pipeline.ts`; cleared via `clearPipeline` on completion.
- `memory-store/entry-schema.ts:15-21` — extend kind enum with `"chunk_summary"`.
- `memory-store/recorder.ts:48-114` — add `recordChunkSummary(cwd, brief, sourceRef)` following the same shape as `recordImplementSummary`. Records the reflection's `nextFocus` + `whatHappened` so a future `/continue` can pick up mid-stream.

### Provider prompt
- `providers/prompt/sections/task-guidelines.ts` — replace the PR #14 CHUNKING block with a one-liner: *"A chunk-planner decides the next 1-5 files for you. Honour `chunkPlanBrief.files` exactly when present; don't reach beyond it. Reflector verifies after — re-plan automatically if it flags issues."* Removes the self-management burden from the main model.

### Flags
- `services/flags.ts:51-66` — add `defineFlag("reasoning.chunked_loop_enabled", false, parseBool)`. Default OFF for staged rollout. Two helper flags for tuning later: `reasoning.max_chunks_per_run` (default 12), `reasoning.skip_chunked_for_simple_intent` (default true).

### CLI client
- `cli-client/src/agent/agent.ts:231-294` — read `response.chunkPlanBrief` + `response.chunkReflectionBrief` per turn. Plumb to a new render call.
- `cli-client/src/cli/render.ts:204-235` — new `renderChunkProgress({ index, total, plan, reflection })` next to `renderPipelineBox`. One-line summary: `▸ chunk 2/5 · planner: write models · ✔ last chunk coherent`. Don't replace the pipeline box — augment.

## Migrations / data

N/A. Per-run chunk state is in-memory only. Memory store gets a new kind value but the on-disk format is append-only markdown with `kind: chunk_summary` — no migration needed for existing entries.

## Hooks / skills / settings to update

- No `.claude/hooks/` changes.
- `.claude/knowledge/architecture.md` — once implemented, add an entry describing the reason→chunk→reflect loop so future contributors don't re-invent it.

## Dependencies

- No new npm packages.
- No new env vars (uses existing `GEMINI_API_KEY`).
- Increased Gemini Flash quota usage: roughly 2 extra Flash calls per chunk × N chunks. With caching + the trivial-task short-circuit, expect ~3-8 extra Flash calls per implement-class run. Free Gemini quota (~15 RPM) handles this comfortably for single-user use.

## Risks & mitigations

- **Free Gemini Flash rate limit (15 RPM)** → cache chunk plans by `(preflight-brief-hash + chunk-history-hash)`; reuse identical states; bound per-run chunk count via `reasoning.max_chunks_per_run`.
- **Latency goes up — N short turns slower wall-clock than 1 fat turn** → render chunk-progress in real time so user sees motion, parallelise reads inside each chunk, keep chunk-planner output tight (<500 tokens) so its round-trip is <2s.
- **Planner ↔ main-model disagreement (planner says A, model writes B)** → tight Zod schema for `chunkPlanBrief.files`; main-model prompt instructed to honour the file list; reflector re-plans on first divergence rather than letting it cascade.
- **Reasoner failure (`GEMINI_API_KEY` unset, network blip)** → if `chunk_plan` returns null, fall back to current PR #14 self-managed CHUNKING behaviour for that turn — don't abort the run.
- **Infinite-loop bug** → hard cap at `max_chunks_per_run` (default 12); reflector's `shouldStop: true` short-circuits early; both checked in `tool-result.ts` before firing the next planner call.
- **Trivial tasks pay the chunked-loop tax for no reason** → if intent classifier returns `simple` or `summary`, OR if preflight's expected file count is ≤3, skip the chunked loop and use the existing flow.

## Implementation order

Each stage is a separate PR. Stages 1-3 are foundation (no behaviour change for users); stage 4 is the first user-visible turn-on; stages 5-7 polish.

### Stage 1 — Schema + pipeline scaffolding
1. Extend `reasoning-schema.ts`: add pipeline values + brief schemas + `assertEnvelopeShape` cases. Tests in `reasoning-schema.test.ts`.
2. Add `pipelines/chunk-plan-pipeline.ts` and `pipelines/chunk-reflector-pipeline.ts` with system prompts + exported `*_SYSTEM_PROMPT` constants.
3. Extend `pipelines/index.ts` `PipelineKind` + dispatch.
4. Extend `task-reasoner.ts` `pickPipeline()` to accept `"chunk_plan"` / `"chunk_reflect"` triggers.
5. Add the kill flag `reasoning.chunked_loop_enabled` (default OFF) + `max_chunks_per_run` (12).
6. Tests: parse a fixture chunk_plan response, parse a fixture chunk_reflect response, round-trip both through `runReasoning()`.

### Stage 2 — chunk-state + memory recorder
1. New `services/chunk-state.ts` with the API listed above. In-memory `Map<runId, ChunkBoundary[]>`.
2. Extend `memory-store/entry-schema.ts` enum with `"chunk_summary"`.
3. Add `recordChunkSummary()` to `memory-store/recorder.ts` mirroring `recordImplementSummary()`.
4. Tests: record + read back a chunk summary, verify the new kind validates.

### Stage 3 — handler integration (still flag-gated OFF)
1. `user-message.ts`: after preflight, if `chunked_loop_enabled`, call `runReasoning({ trigger: "chunk_plan", ... })` and stash on `clientResp.chunkPlanBrief`.
2. `tool-result.ts`: per turn, fire `chunk_reflect` then `chunk_plan` before `callModelAdapter`. Update chunk-state. On reflector's `shouldStop`, short-circuit to `kind: "completed"`.
3. Cap loop at `max_chunks_per_run`. On exceeded, emit a clear `failed` envelope.
4. Trivial-task short-circuit: skip chunk-planner when intent is `simple`/`summary`, OR when prefilght's `implementBrief` (if present) lists ≤3 files.
5. Tests: `tool-result.test.ts` mock the model + reasoner, run a 3-chunk loop, assert reflection + memory writes happen.

### Stage 4 — Provider prompt + first user-visible turn-on
1. Replace PR #14 CHUNKING block in `task-guidelines.ts` with the planner-deferred one-liner.
2. Inject `chunkPlanBrief` into the provider's user-message section so the main model sees `nextAction` + `files`.
3. Flip `reasoning.chunked_loop_enabled` default from `false` → `true`.
4. Manual smoke: run the e-commerce backend prompt, watch chunks 1..N go through; expect ≤4 files per chunk and no 402.

### Stage 5 — CLI rendering
1. `cli-client/src/agent/agent.ts` — read the two new brief fields per turn; pass to render.
2. `cli-client/src/cli/render.ts` — `renderChunkProgress()` function. One-line by default; `Tab` to expand reflection.
3. Manual: chunk boundaries visible in the CLI; user can see *"chunk 3/5 · writing routes"*.

### Stage 6 — Caching + observability
1. Cache chunk plans by `(briefHash + chunkHistoryHash)` using the existing `reasoning-cache` module.
2. Add per-run telemetry: `chunkCount`, `flashCallsCount`, `mainModelTokens`. Surfaces in `recordRunSummary`.
3. Tests: cache hit/miss for repeated chunk plans.

### Stage 7 — Documentation
1. `.claude/knowledge/architecture.md` — document the chunked loop with a small ASCII flow diagram.
2. `.claude/knowledge/decisions.md` — record *why* we picked planner-per-chunk over chunk self-management (PR #14's approach).

## Verification

Per stage:
- `npm run typecheck` clean
- `npm test` — existing 188 server + 67 cli tests still pass; new tests added per stage.

End-to-end (after Stage 4):
- Run *"create an ecommerce backend with products, orders, users, login, register, use express"* on a free OpenRouter account.
- **Expected**: ≥3 chunks, each with ≤5 `write_file` calls; no 402 errors; total run cost ≤ 60% of the equivalent bulk run; final summary equivalent quality (all expected files present, server.js wires routes correctly).
- **Memory**: `.sysflow-memory.md` contains 1 implement_summary + N chunk_summary entries after the run.
- **CLI**: chunk boundaries visible; per-chunk planner rationale browsable via Tab.

Metrics to watch (Stage 6):
- Mean chunks per implement run (target: 3-7)
- Flash calls per run (target: ≤ 2 × chunks + 1 preflight)
- Main-model tokens per chunk (target: ≤ 8000 output)
- Run wall-clock vs pre-Phase-10 baseline (target: ≤ +25% latency for ≤ -50% main-model token cost)

## Out of scope

- Cross-run chunk persistence (Phase 8 memory already covers this).
- Streaming chunk delivery — main-model still emits chunks as discrete responses; SSE chunks-within-chunks is a later optimisation.
- Multi-agent / parallel chunks across the same run — sequential only for v1; paralleling chunks is Phase 11+ if metrics show it's worth it.
- Reasoner-driven backtrack on bad chunks — for v1, a flagged-bad chunk just triggers a re-plan; we don't `git reset` the chunk's writes.

## Foundation iteration policy

This phase exercises the reasoning + memory systems harder than they've been used before — every chunk runs Flash twice and writes a `chunk_summary` entry. **If implementation reveals a foundation gap, fix the foundation, not the symptom.** Examples of legitimate scope-expansion during apply:

- Reasoning envelope schema is too rigid for the new brief shapes → extend the discriminated union, don't `unknown`-cast around it.
- The sha256 cache key is too coarse for chunk-plan reuse (matches identical input, misses semantically-equivalent input) → expand the cache-key derivation in `reasoning-cache.ts`.
- Memory entries get noisy after a multi-chunk run → tighten compaction or add a kind-aware retention policy in `memory-store/compactor.ts`.
- Per-pipeline prompt files get repetitive → factor a shared helper in `pipelines/index.ts`.

These count as in-scope foundation work for whichever stage surfaces the gap. Out-of-scope is anything that's *not* a downstream consequence of this phase's load (e.g. don't redo the whole memory file format here just because we're touching the recorder).
