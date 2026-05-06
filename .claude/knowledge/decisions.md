# Decisions

Non-obvious choices and why we made them. Include the alternatives we rejected so future readers can re-evaluate when the context shifts.

## Planner ↔ reflector are additive, not merged

- **Source:** plan `applied/2026-05-06-phase-10-chunked-reasoning-loop.md`

Phase 10's chunked-reasoning loop fires **two separate** Gemini Flash calls per chunk: one before the main model executes (chunk-planner) and one after (chunk-reflector). The cheaper-looking design — one combined `chunk_step` Flash call that does both jobs — was rejected.

**Why two:**

1. **Different concerns.** Reflector validates THIS chunk ("did the writes I just made compile and cohere?"). Planner picks the NEXT chunk ("what files come next?"). Merging dilutes the prompt for both — the model has to context-switch mid-response.
2. **Different cadence.** Reflector runs every chunk; planner can be skipped on `shouldStop` or when the cap is hit. Merging forces both to run at the higher frequency, doubling cost on the path we'd want to skip.
3. **Different failure modes.** A chunk can be coherent (reflector ✓) but the run is wrong (a future awareness/divergence detector — Phase 11 — adds the macro-level check). And vice versa — a chunk can have a broken import (reflector ✗) on a correctly-aimed run. Treating them as one signal loses the distinction.
4. **Different kill switches.** A future operator should be able to disable just the reflector or just the planner without touching the other. Independent flags require independent endpoints.

## Render natural agent steps, not "chunk N/M" UI

- **Source:** PR #19 user-feedback round
- **Decision:** the chunk-progress renderer (`cli-client/src/cli/render.ts: renderChunkProgress`) emits `▸ write models (3 files)` instead of `▸ chunk 2/5 · write models · ✔ last chunk coherent`.

The user shouldn't need to know the agent runs in a planner→execute→reflect loop. Showing "chunk N" leaks implementation detail and trains them on terminology that may not survive Phase 11+ refinements. Coherent reflections stay silent (no "✔ last chunk coherent" noise); only when the reflector flags `coherent: false` does it surface, framed naturally as *"⚠ N things to fix from last step"*.

## chunk_plan + chunk_reflect share one kill flag

- **Source:** plan `applied/2026-05-06-phase-10-chunked-reasoning-loop.md` (Stage 1)

`reasoning.chunked_loop_enabled` toggles both triggers as a unit. There's no useful state where the planner runs without the reflector or vice versa — the reflector exists specifically to gate the next planner call's behaviour. Per-trigger flags would just add a footgun where someone disables one and accidentally creates an incoherent loop.

The OTHER reasoning triggers (preflight, on_error, on_completion, self_invoked) keep their per-trigger flags (`prompt.<trigger>_reasoning_enabled`) because they ARE independently useful.

## chunk planner cap of 5 files per chunk (not 8)

- **Source:** plan `applied/2026-05-06-phase-10-chunked-reasoning-loop.md` (Stage 1, schema)

`chunkPlanBriefSchema.files.max(5)` is enforced at the Zod boundary. The previous PARALLELISM rule allowed 8 file writes per batch (PR #14), but 8 files of source can comfortably exceed 15k output tokens — the affordability ceiling on free OpenRouter accounts. 5 keeps each chunk inside the affordable budget without preemptively capping `max_tokens` (which would truncate responses even when credits are fine).

## Default `reasoning.chunked_loop_enabled = true`

- **Source:** plan `applied/2026-05-06-phase-10-chunked-reasoning-loop.md` (Stage 4)

Flag defaults to `true` after Stage 4 because the loop degrades gracefully on missing `GEMINI_API_KEY` (Flash returns null → handlers fall back to legacy single-turn flow). Self-hosters who don't set the key get the legacy behaviour for free; those who set the key get the chunked loop without having to discover and flip a flag.
