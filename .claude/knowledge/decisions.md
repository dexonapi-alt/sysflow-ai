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

## Awareness signal sources are peers, not chained

- **Source:** plan `applied/2026-05-06-phase-11-awareness-and-recovery.md`

Phase 11's awareness loop has **three** signal sources — heuristic detector, ground-truth verification gate, LLM divergence verdict — and they all feed the SAME `confidence-tracker.recordSignals()` per chunk. The chained design (heuristic → if positive run gate → if positive run LLM) was rejected.

**Why peers:**

1. **Different blast radii.** Heuristic catches stuck-loops + scope creep (intra-run). Gate catches broken imports + missing deps (intra-chunk). LLM catches macro-level intent drift (cross-chunk semantic). Chaining one gates a category of detection on another category firing first, which means a clean-on-disk run with macro drift would never reach the LLM check.
2. **Different costs.** Heuristic is in-memory pure. Gate is <1s of disk I/O. LLM is ~300 tok of Flash. Chaining doesn't save anything when the heuristic IS firing — and on a clean-but-drifting run it actively skips the most informative check.
3. **Different latency tolerances.** Heuristic + gate run on every chunk; the LLM has its own cadence (every 2nd chunk OR on heuristic-fire) and a per-run cap (`MAX_LLM_DIVERGENCE_PER_RUN = 8`). A chain forces all three to share the slowest cadence.

The tracker is the only place that sees their union, and decay weights are tuned per category so an `llm_off_track` from Flash counts as much as an `intent_keyword_absent` heuristic (both base 25). Heuristic mkdir-empty stays soft (5).

## `awareness.enabled` is a single flag for all three signal sources

- **Source:** plan `applied/2026-05-06-phase-11-awareness-and-recovery.md` (Stage 4)

Like `reasoning.chunked_loop_enabled` for Phase 10, `awareness.enabled` toggles the heuristic detector + verification gate + LLM divergence pipeline as a unit. Per-source flags would let an operator disable the LLM half (saving Flash cost) while keeping heuristic + gate active — but the LLM's main job is to catch the macro-drift case the other two miss, and disabling it specifically is the worst combination. If someone wants pure heuristic-only mode, the lever is `prompt.divergence_check_reasoning_enabled` via the flag-name routing in `task-reasoner.ts` (the per-trigger flag is registered for symmetry with the other reasoning triggers).

The OTHER awareness flags (`awareness.threshold_off_course`, `awareness.threshold_blocked`) ARE per-knob because operators DO want to tune them independently when free-tier metrics shift.

## Backtrack drops chunk-state on the server

- **Source:** plan `applied/2026-05-06-phase-11-awareness-and-recovery.md` (Stage 4)

When the user picks `b` in the off-course modal, the cli rolls back disk via `rollbackToChunk` and the server clears chunk-state + pipeline (`clearChunkState` + `clearPipeline`). Two simpler designs were rejected:

1. **Trim chunk-state to lastGoodChunkIndex but keep the rest.** Tempting because the planner could resume mid-run with prior context, but it leaves the chunk-history claiming files exist that the rollback just removed. Next reflector call would see "files don't exist" → emit chunk_summary issues → next planner re-plans anyway. Just confused state in the meantime.
2. **Re-bootstrap the planner mid-run.** Cleaner UX (the loop continues seamlessly), but it requires the planner to know it's resuming after a rollback vs. starting fresh — a state distinction that adds complexity for a flow we expect to be rare. Stage 4 punted on this; the user can re-prompt for a clean restart.

The current design accepts a small UX downgrade after backtrack (no chunked loop for the rest of the run, just regular main-model calls) in exchange for simple, correct state. If metrics show backtrack happens often enough to matter, Phase 12 can add the re-bootstrap.

## Default `awareness.enabled = true`

- **Source:** plan `applied/2026-05-06-phase-11-awareness-and-recovery.md` (Stage 4)

Same logic as `reasoning.chunked_loop_enabled = true`: the awareness loop degrades gracefully when `GEMINI_API_KEY` is unset (the LLM half short-circuits at the trigger gate; heuristic + gate keep firing on their own). Self-hosters get useful detection without any setup. The off-course modal won't fire spuriously because the threshold-blocked floor (30/100) requires multiple major signals — single-source false positives can't cross it alone.
