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

## Breath is the single visual metaphor for the living CLI

- **Source:** plan `applied/2026-05-07-phase-12-living-cli-ui.md`

Phase 12's design language uses **one** animation metaphor — a slow, organic, sin-based breath curve — across every visible region: spinner glyph, bottom-row status, chat-input cursor, awareness badge gradient, modal evidence. Three explicit tempos (`activeBpm = 60`, `idleBpm = 20`, `modalBpm = 40`) cover the entire speed range. Alternatives rejected:

1. **Per-component idioms** (rotating dots for spinner, bouncing bar for progress, blinking caret for cursor). Reads as a junk drawer of motion — the eye can't tell what's load vs. decoration. A single curve unifies the language.
2. **Faster pulses (>90bpm)**. Strobing is the failure mode of "alive" UIs. Anything faster than a calm resting heart rate trips the same neural circuits as flashing-light warnings, exactly the wrong feel for a tool the user runs for hours.
3. **Multiple concurrent breaths in the same line of sight**. Tested early — two breaths at different tempos in the same row reads as chaos, not life. The composition rule (one breath per visible region, called out in `Breath.tsx`) keeps the design coherent.

Tempo is locked in `cli-client/src/ui/theme.ts`. A future re-skin should start there; do **not** dial up the bpm to make the UI feel "snappier" — that's exactly the design failure this entry exists to prevent.

## Pure shape functions instead of `ink-testing-library`

- **Source:** plan `applied/2026-05-07-phase-12-living-cli-ui.md` (Stage 2)

Every Phase 12 animation primitive (`<Breath>`, `<Pulse>`, `<Shimmer>`, `<Fade>`, `<Typewriter>`) ships a pure shape function alongside the React component. The component is a thin React wrapper that subscribes to `useFrame` and calls the compute fn each tick. **Tests target the pure helpers directly**, asserting visual contracts without rendering through Ink.

`ink-testing-library` was deliberately not added. Reasons:

1. **Dependency surface.** The plan called out *"resist the urge to pull in ink-spinner / ink-text-input"* — same applies to ink-testing-library. Rendering Ink in tests adds a slow, brittle layer that yields little signal beyond what the pure shape function would.
2. **Decoupling.** A pure compute fn is reusable from a non-React renderer (e.g. a future status-line variant in legacy console mode). Tying the contract to Ink's API would lock it in.
3. **Speed.** Pure-fn tests run in microseconds; Ink-rendered tests would dominate the cli suite's runtime.

When a future component needs to assert React-specific behaviour (effects, reconciliation, key-driven remounts), reach for the lightest possible test — `vi.spyOn` + manual reducer calls — before reaching for ink-testing-library.

## Modal Ink-port deferred from Phase 12

- **Source:** plan `applied/2026-05-07-phase-12-living-cli-ui.md` (Stage 7)

The Stage 7 plan called for porting `<PermissionModal>` and `<OffCourseModal>` from raw-TTY (`cli-client/src/cli/{permission-prompt,off-course-prompt}.ts`) to Ink components with slide-in + focus-pulse + breath-on-evidence. **Both were deliberately deferred.**

Why:
- The existing helpers expose a synchronous-promise contract (`askPermission()` / `askOffCourse()` return a `Promise<Result>` the agent loop awaits). Porting to Ink requires either (a) rewriting the contract to be event-driven, (b) building a stdin-handover bridge that suspends Ink's own input loop while the modal is open, or (c) duplicating the modal in both modes. None are small.
- The raw-TTY modals work today and don't break the alive feel — they're brief interruptions and the user spends most of their time outside them.
- The visible alive-feel is delivered by the always-on zones (Header / LiveStatusBar / ChatInput cursor / tool cards / Typewriter), not by modals that fire a few times per session at most.

When to revisit: if user feedback specifically calls out modal feel as breaking the design, OR if the modal fire rate climbs (e.g. permission system gets noisier). Until then, the cost is too high for the win.

## ●-bullet ActionCards instead of bordered boxes

- **Source:** plan `applied/2026-05-07-phase-14-premium-cli-experience.md` (Stage 2)

Phase 14 replaced Phase 12's `<ToolCard>` (a `╭── ──╮` ASCII-box header + body) with `<ActionCard>` — a single-line `● Verb(target)` header followed by an optional `⎿ Added X lines, removed Y lines` summary, no surrounding chrome. The pipeline-plan box (`renderPipelineBox`) and per-tool diff-preview boxes were dropped from the Ink path at the same time.

**Why bullets won:**

1. **Visual density.** A bordered card consumes 4 lines (top + body + bot + gap) for what is conceptually a one-liner. A multi-tool turn could fill a screen with chrome before any actual content. The Claude reference proves the indented-list format reads as MORE premium when done well — colour, indentation, and subtle separators (`⎿`, `●`, `○`) carry the visual rhythm without ASCII walls.
2. **The breath metaphor reads better on a bullet.** `<Pulse>` on a `●` is more legible than `<Pulse>` on a corner glyph. The bullet IS the state indicator (running pulse, success muted, error red); the box was decoration.
3. **Settled cards move to `<Static>`** so they don't re-render per frame. With boxes, the container border was redundantly part of the static render every time anything inside was settled.

The legacy console renderer keeps the boxes (`renderPipelineBox` is gated behind `!isInkActive()`) — this is purely about the Ink path. Box-drawing characters are still legitimate for things that ARE containers (the off-course modal, the permission prompt). They were the wrong shape for a stream of tool calls.

## RichSpinner: single colour-shifting glyph, NOT a 4-glyph swirl

- **Source:** plan `applied/2026-05-07-phase-14-premium-cli-experience.md` (Stage 3) + follow-up PR #44
- **Final design:** one glyph at a time from `SPINNER_GLYPHS = ["✢", "✺", "✣", "✤"]`, swapped every 250ms (4 frames per breath at 60bpm). Each glyph paired with its own hex via `SPINNER_COLORS = [accent, tool, info, success]` (purple → teal → blue → green) so the swap is unmistakable.

The original Stage 3 plan called for a 4-glyph row rendered side-by-side with one bright + three dimmed (a "swirl"). User feedback after merge: too subtle on most terminals — the eye read it as a static row, not motion. Shipped a follow-up that flipped to single-glyph, where the colour shift carries the rotation.

**What we kept:**

- The glyph SET stayed `✢ ✺ ✣ ✤` — chosen for visual similarity (all 4-pointed star variants) so the swap reads as one motif rotating, not four glyphs flickering.
- The 250ms cadence (one full revolution per `tempo.activeBpm` breath period) — same rhythm as everything else in the design language.
- `--no-motion` pins to index 0 (the brand-accent purple `✢`).

**What we rejected at the same time:**

- *4-glyph row with brightness highlight.* Too subtle. Burned the lesson into a comment in `RichSpinner.tsx`'s header docstring so a future contributor doesn't reach for it again.
- *Spinning braille (`⠋ ⠙ ⠹ …`).* It works for ora but reads as "AI thinking" terminology — exactly the generic feel Phase 14 was fighting.

The colour palette is intentionally cool-only (purple / teal / blue / green) — warm hues (yellow/red) read as warning or alert, not "alive working".

## Workflow-flavoured verb cycle (22 entries) instead of generic "thinking"

- **Source:** PR #45 (post-Stage 3 follow-up)
- **Decision:** the spinner verb cycle is curated to feel like a human thinking through a problem, not a placeholder. The list mixes interjections (`hmm…`) with action verbs (`debugging…`, `searching…`, `deciding…`, `weighing options…`).

**Why 22 verbs (not 7, not random):**

1. **Cycle length matters.** At `VERB_MS = 3000` and 7 verbs, the loop is 21s — short enough that a 30s wait cycles back to the same word. 22 verbs gives ~66s, well past the duration of most agent pauses.
2. **Curated alternation > random shuffle.** The order interleaves action verbs and interjections (`thinking → hmm → considering → weighing options …`) so consecutive ticks read as varied rhythm. Randomising would make tests flaky and the cadence harder to reason about for the same perceived variety.
3. **`thinking` stays first** — it's the friendliest opener and the one users associate with the spinner. Position 0 is also where motion-disabled mode pins.

**The other half of this fix:** in `agent.ts: createSpinner` the initial Ink emit changed from `{type:"spinner", text:"thinking..."}` to `{type:"spinner", text:""}`. With a non-empty initial text, the cycle was effectively dead code — every mount started with `text="thinking..."` overriding it for the entire wait. Empty initial → cycle takes over, server phase events still override when they fire.

A future tool-aware override (e.g. surface `searching…` while `grep` is running) would derive the verb from the running tool's name and pass it as the `text` prop. The `VERBS` array is exported for that path.

## Console-redirect gating via `shouldRenderInlineForLegacy()`

- **Source:** plan `applied/2026-05-07-phase-14-premium-cli-experience.md` (Stage 1)

Phase 12 introduced `redirectConsoleToInk()` so existing `console.log` calls in `agent.ts` would route through the events bus when Ink is mounted. But several agent callsites print THEIR OWN heavy chrome (`renderPipelineBox` for the chunk plan, the `boxTop("SUMMARY") + boxMid + boxBot` block in `renderCompletion`, raw `process.stdout.write("\\x1b[${n}A")` cursor-ups around the in-flight tool list) — those needed to be skipped wholesale in Ink mode, not just redirected.

The canonical predicate is `cli-client/src/agent/events.ts: shouldRenderInlineForLegacy()`, which returns `!isInkActive()`. Phase 14 Stage 1 gated four `agent.ts` callsites behind it; Stage 4 added three more for the legacy `renderReasoningBrief` / `renderDecisionBrief` calls.

**Why a named predicate, not raw `!isInkActive()`:**

1. **Discoverability.** A new contributor adding a console renderer can grep for `shouldRenderInlineForLegacy` and see exactly which callsites are dual-mode. `!isInkActive()` is less greppable and reads as "is X false" instead of "should I render this for the legacy console".
2. **One place to change the meaning.** If a future flag (`SYS_LEGACY_INLINE=1`) wants to force inline rendering even with Ink active, the predicate is the single point to extend.
3. **Symmetry with `isInkActive()`.** Two predicates side by side describe the dual-mode contract clearly: one for "should I emit Ink events", one for "should I render for the legacy console".
