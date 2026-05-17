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

## Active memory feedback is model-driven, not heuristic

- **Source:** plan `applied/2026-05-07-phase-15-memory-handling-anti-staleness.md` (Stages 3-4)

Phase 15 closes the active-confirmation loop by asking the **model** to declare which memory entries it used (`confirmed`) and which it disagreed with (`contradicted`) on each turn, in a structured `memoryFeedback` field on the response JSON. The handler then mutates the store via `noteAgreement` / `noteContradiction`. Two heuristic-only alternatives were considered + rejected:

1. **Pure post-hoc inference.** Read the model's response, scan for entry-id mentions or content overlap with each recalled entry, infer "this entry was used" without asking. Rejected because it conflates "model used the knowledge" with "model wrote text similar to the entry" — a model can quote an entry while disagreeing with it, or use the underlying knowledge without echoing the entry's surface form. Token-overlap heuristics alone produce too many false positives, especially on short replies.
2. **Periodic LLM judging.** Fire a separate Flash call per N turns asking "which of these entries did the agent use?" Rejected because it doubles the per-turn Flash cost on a problem the main model can self-report cheaply, and the judging Flash would face the same overlap-vs-usage ambiguity from the outside.

The model-driven design wins because the model alone knows which memories actually steered its decision. Heuristics protect against hallucinations (next decision below) so a free-tier model claiming `confirmed: ["abc123"]` for an entry it never used can't pollute useCount.

## Cross-validation guards are asymmetric (looser for confirm, stricter for contradict)

- **Source:** plan `applied/2026-05-07-phase-15-memory-handling-anti-staleness.md` (Stage 3)

`applyMemoryFeedback` cross-validates each model claim before mutating the store. The two guards intentionally differ in strictness:

- **`validateConfirmation`** uses **30% token overlap** between entry content and response text (case-folded, dash-split, stopword-stripped, ≥4-char tokens). Looser bar — false confirms cost a single extra useCount bump.
- **`validateContradiction`** requires the response to contain **`[<id>]` in literal bracket notation** (the exact format LEARNED_MEMORY uses to render entries). Stricter bar — killing an entry is irreversible after 2 strikes.

The asymmetry is the design point. Honouring a fabricated confirm is cheap (the worst case is one bumped useCount on an irrelevant entry, which the recall scoring quickly outpaces). Honouring a fabricated contradict is expensive (the entry is gone after 2 strikes; legitimate knowledge is lost). When the cost of a false positive is asymmetric, the guard should be too.

The bracket-id requirement also serves a UX purpose: if the model wants to contradict an entry, it has to point at it in the response text, so the user can see what was disagreed with and why. The cross-validation isn't just hallucination defence; it's also a self-auditing contract — the response itself documents which entries the model rejected.

## Original-intent reader prefers longest substantive entry over current prompt

- **Source:** plan `applied/2026-05-07-phase-15-memory-handling-anti-staleness.md` (Stage 5)

The Phase 11 divergence pipeline anchors on the user's literal prompt. Today that means `run.content` — fine for new runs, broken for `/continue` and follow-up fix runs where `run.content` is `"continue"` / `"fix it"` / `"what's missing?"`. Three resolution strategies were considered:

1. **Anchor on the current `run.content` always** (Phase 11 default). Simplest, but breaks awareness for the most common follow-up shape — exactly when the user is most likely to want awareness.
2. **Anchor on the `chunk_summary` chain** (synthesise from chunk history). Works mid-run but doesn't help on the first chunk of a `/continue` run, when no chunk history exists yet.
3. **Anchor on `original_intent` memory entries** (Phase 15 Stage 5). The verbatim user prompt from any prior run, recorded persistently. Pre-existing data, no new emission needed.

We chose (3), with a hybrid heuristic: use the current prompt verbatim when it's substantive (≥ 30 chars after trim), otherwise fall back to the longest `original_intent` candidate. The 30-char threshold is curated — `"build a postgres-backed user API"` is 32 chars; typical follow-up prompts sit well below it.

Why "longest" rather than "most-recent" or "most-confirmed":
- Most-recent risks picking another short follow-up if the user submitted multiple in a row.
- Most-confirmed (highest useCount) is a reasonable signal but currently zero on free-tier where the active confirmation loop is brand new and entries haven't accumulated history yet.
- Longest is a cheap proxy for "most descriptive" — a 200-char architectural prompt beats a 40-char one-liner for divergence anchoring purposes.

When this needs to evolve: if the recall score (recency × useCount × overlap) becomes load-bearing for memory in general, route through `recallForReasoning` directly and trust its scoring. For now the simpler "longest after threshold" rule is well-tested and predictable.

## Chain WITHIN a concern, peer ACROSS concerns

- **Source:** plan `applied/2026-05-07-phase-16-deep-reasoning-on-free-models.md`

Phase 16 introduces chained Flash calls for the first time (`runReasoningChain`). The composition rule: chain the second stage with the first only when they're answering the SAME question more deeply. Different concerns stay peers via `confidence-tracker.recordSignals()` (Phase 11's design — see *Awareness signal sources are peers, not chained*).

Concrete examples from the live code:

- **Implement preflight → implement_elaborate** (Phase 16 Stage 3): same concern (what's the right approach?). Chain.
- **First divergence verdict → second-look divergence** (Phase 16 Stage 4): same concern (is the run on-track?). Chain.
- **Heuristic detector + verification gate + LLM divergence** (Phase 11): three concerns (intra-run loops / disk-side correctness / cross-chunk macro drift). Peers.
- **chunk_plan → chunk_reflect** (Phase 10): two concerns (what next? / did the last chunk land?). Peers — see existing decision *Planner ↔ reflector are additive, not merged*.

The rule keeps the chain helper from over-engineering. Two-Flash chains within a concern are a 1.5× cost for a substantively deeper answer; chaining across concerns would dilute both stages' prompts and double the cost without the second view actually scrutinising the first.

A future fourth chain (Phase 18's `task_confirmation` for example) reuses `runReasoningChain` without re-implementing the orchestration.

## Free-tier policy is a centralised module, not scattered checks

- **Source:** plan `applied/2026-05-07-phase-16-deep-reasoning-on-free-models.md` (Stage 1)

Phase 11 introduced `isFreeTierModel` + `FREE_MODEL_SENSITIVITY_BUMP` inside `confidence-tracker.ts`. By Stage 5 of Phase 16, four separate code paths needed free-tier-aware behaviour: confidence thresholds (Phase 11), preflight elaboration gate (Stage 3), divergence second-look gate (Stage 4), chunk caps (Stage 5). Two structural options were considered:

1. **Each call site does its own `isFreeTierModel` check.** Easy to write each one; over time produces 4+ scattered policy decisions that drift apart when one stage's tuning changes. The "treat free-tier differently" intent is implicit and fragmented.
2. **One module owns the policy.** `server/src/services/free-tier-policy.ts` declares every constant + every gate helper. Each call site imports the helper it needs. New free-tier behaviour adds a helper here, not a check there.

We chose (2). `confidence-tracker.ts` re-exports `isFreeTierModel` and `FREE_MODEL_SENSITIVITY_BUMP` for back-compat so Phase 11 importers keep working. New consumers import from the policy module directly.

The discipline: when a future stage wants to adapt for free-tier, it adds either a constant or a pure helper to `free-tier-policy.ts` and the call site reads from there. No raw `isFreeTierModel(...)` checks in handlers — they should always be inside a policy helper.

## Why LLM intent classification beats regex + what the fallback looks like

- **Source:** plan `applied/2026-05-15-llm-iterative-intent-classification.md`

Intent classification is the single most-load-bearing routing decision in the system — it drives the preflight pipeline pick, Phase 18's taskPlan emission gate, and Phase 19's cli render gate. A misclassification cascades. The pre-plan synchronous regex hit the same failure repeatedly:

- Feature-list nouns containing `error` / `fail` / `exception` / `crash` tripped the BUG_PATTERNS regex on build prompts that mentioned *"error handling"*, *"failure recovery"*, *"exception middleware"*. PR #82's implement-anchor regex band-aided this for prompts that START with a build verb, but compound nouns inside the prompt body kept biting.
- The regex has no understanding of CONTEXT: *"explain why this throws an error"* (summary) vs *"the auth service throws an error on login"* (bug) both look the same to `\berror\b`.

The LLM with iterative paragraph reasoning fixes the underlying problem instead of patching specific cases:

**Why the iterative chain beats both single-shot LLM and the regex:**

1. **Single-shot LLM**: one call per classification. Burns Flash on every prompt — including obvious ones. No revisitation.
2. **Iterative paragraph chain (chosen)**: LLM owns its own depth via `done` flag. Trivial prompts settle in 1 iteration. Genuinely ambiguous prompts (mixed verbs, *"make this faster"* could be optimisation or regression) trigger 2-3 iterations where each paragraph addresses the open question from the prior one. Senior-engineer rubric forces structured thinking (restate / why this vs alternatives / trade-offs / end-to-end / double-check / decide). Same pattern that already proved out for preflight reasoning (`runIterativeChain` in `task-reasoner.ts`).
3. **Regex (kept as fast-path + fallback)**: still cheap, still synchronous, still correct for the easy cases (`/continue`, `ls src`). The regex catches obvious classes; the LLM catches everything else.

**The fallback rule: regex is the safety net, not the primary path.**

When the chain returns `null` — no reasoner backend available, parse failure, chain ran to the cap without committing — the smart classifier returns the regex's result with `source: "regex_fallback"`. The system NEVER blocks on intent classification; the regex is the last-resort default that ALWAYS yields some hint. This is the same defense-in-depth shape Phase 16 used (`pickReasonerBackend` returns null → legacy single-turn flow).

**Per-run cache makes the LLM cost bounded.**

Classification fires ONCE per run. The first turn goes through the smart classifier (potentially 1-6 Flash iterations); every subsequent turn (tool-result responses, pickPipeline calls) reads from the cache. Total Flash spend per run for classification: ~1 call on average, capped at 6 on the ambiguous tail. Telemetry (`intentClassificationSource` in usage.jsonl) shows the distribution so operators can tune the depth cap or fast-path flag.

**Rejected alternatives:**

1. **Drop the regex entirely.** Tempting for simplicity but breaks every existing sync caller (`pickPipeline` in `task-reasoner.ts` is invoked from many places inside the reasoning module and going async would cascade). Also kills the fallback path — runs with no API keys would have no classification at all.
2. **Stack two regexes (current + a "secondary" one that catches the compound-noun trap).** That's exactly what PR #82's implement-anchor regex did. It works for SOME cases but each new trap requires a new regex; the trap surface grows with each new compound-noun construction the user uses. The LLM closes the surface structurally.
3. **Train a small ML classifier (fastText / equivalent) for intent.** More accurate than regex, but adds a new dependency + training pipeline + model file. The LLM is already in the system; reusing it for one more decision is leaner.
4. **Make the chain mandatory (no fallback).** Bricks every install without a configured API key, including the test suite that runs without env. Fallback is non-negotiable.

**When to revisit:**

- If `intentClassificationSource` telemetry shows `regex_fallback` rate > 10% of runs, the LLM path is degrading more often than it should. Investigate which backend is failing.
- If `intent_classification_max_iterations` flag value gets bumped above 6 by an operator, the LLM is iterating too long — the rubric needs tightening to push more aggressive commits in paragraph 1.

## TaskPlan emission gates on intent + complexity (server-side companion to the cli render gate)

- **Source:** plan `applied/2026-05-07-phase-18-pre-task-deep-reasoning-and-complexity.md` (Stage 5)

Phase 19 added a cli RENDER gate on the visible task box; Phase 18 Stage 5 adds the matching server EMISSION gate. The system-rules section's "FIRST RESPONSE (must include taskPlan)" instruction now renders only when the run is `implement`-class AND complexity ≥ medium. Other combinations see a no-taskPlan rubric ("Do NOT include a `taskPlan` field"). A defensive drop in `parseJsonResponse` ALSO removes a stray taskPlan from the normalized response when the gate said skip, so free-tier models that ignore the prompt directive can't blow past the gate. Composes as defense-in-depth with Phase 19.

**The gate matches Phase 19's cli gate.** Both call sites use the same `shouldIncludeTaskPlanInstruction` helper (exported from `system-rules.ts`) — single source of truth for the decision:

- `runIntent === "implement"` AND `complexity ∈ { "medium", "complex" }` → include
- Anything else (simple Q&A, summary, bug-fix Q&A, trivial single-line implements) → omit
- `runIntent == null` or `complexity == null` → include (pre-classification fallback preserves pre-Phase-18 behaviour)
- `gatingEnabled === false` (flag off) → always include (off-switch path)

**Why both an instruction gate AND a normalizer drop:**

The prompt instruction is advisory ("Do NOT include taskPlan"). Free-tier models with weaker instruction-following can ignore it and emit one anyway. Without the normalizer drop, the agent's `ClientResponse.taskPlan` field still populates, the cli reducer sees it, and the user's mental model gets the wrong cue (even if Phase 19's render gate ALSO hides the box, the cli would still emit `task_start` events under the hood). Two-layer gating ensures `taskPlan` is structurally absent for non-implement runs at every layer of the stack.

**Why not Phase 18's original Stages 2-4 (pre-task-reasoning + task-confirmation pipelines):**

The original Phase 18 plan called for two new Flash pipelines (`pre_task_reasoning` producing `whyThisApproach` + alternatives + preconditions; `task_confirmation` re-checking against the literal prompt). Phase 16 shipped first and built `implement_elaborate` — a chained Flash that produces *whyThisApproach* + *whyNotAlternative* + *preconditions* + re-scored confidence on free-tier complex runs. That is operationally Stage 2 + Stage 3 of Phase 18 under a different name. Re-building those stages would produce overlapping abstractions; the cleaner move was to ship Phase 18 Stage 5 (the genuinely-new emission gate) and document the Phase 16 subsumption.

**Per-run state, not per-call:**

The gate is stashed on a `runTaskPlanGate: Map<string, ...>` on the BaseProvider class, set by each provider's `call(payload)` from `payload.runIntent + payload.taskComplexity` before the model invocation. `parseJsonResponse` reads it. Cleared by `clearRunState(runId)` alongside the other per-run state maps. This avoids changing the public `parseJsonResponse(text, runId?)` signature (which many tests depend on) while still threading the gate through.

**Key files:**

- Gate helper: `server/src/providers/prompt/sections/system-rules.ts: shouldIncludeTaskPlanInstruction`
- Conditional renderer: `server/src/providers/prompt/sections/system-rules.ts: getSystemRulesSection({runIntent, complexity, gatingEnabled})`
- Per-run state: `server/src/providers/base-provider.ts: runTaskPlanGate` + `setRunTaskPlanGate`
- Defensive drop: `server/src/providers/base-provider.ts: parseJsonResponse` (taskPlan extraction block)
- Provider hooks: each `call(payload)` in `gemini.ts` / `anthropic.ts` / `openrouter.ts` calls `this.setRunTaskPlanGate(payload)` early
- Handler population: `user-message.ts` + `tool-result.ts` set `runIntent` + `taskComplexity` on `providerPayload` from `classifyIntent(content)` + `analyzeTaskComplexity(content).complexity`
- Flag: `server/src/services/flags.ts: quality.taskplan_emission_gating_enabled` (default `true`)

## Task box gates on intent classification, not on prior-render heuristics

- **Source:** plan `applied/2026-05-07-phase-19-task-display-selectivity.md`

The visible task box at the top of an AgentStream renders ONLY on `implement` runs. Q&A, summary, and bug pipelines surface via tool cards + `<ReasoningPeek>` alone — no multi-step plan ceiling the conversation. Three alternative gating strategies were considered + rejected:

**1. Hide the box if no `task` field on the response.** Server-only signal — the cli renders whatever it gets. Reject: free-tier models ignore the "skip taskPlan for simple Q&A" prompt directive (Phase 18 territory) and emit a task box anyway. The cli has no fallback to hide it, so simple questions get the same multi-step plan ceiling Phase 19 was designed to remove.

**2. Heuristic based on prior rendering (e.g. hide the box after the first turn returns < N tools).** Reactive — by the time the heuristic decides to hide it, the box has already rendered and the user has already seen the multi-step plan UI. The first impression sets the user's mental model; later hiding feels like the UI is broken, not selective.

**3. User-toggle keystroke (`ctrl+h`) to show/hide the box on demand.** Too late — the box is up by default and the user has to remember the keystroke to dismiss it. Phase 19's premise is the box should be ABSENT by default for non-implement runs, surfaced when actually needed. A keystroke could land later as a power-user feature without contradicting the default.

**The rule:** the gate is `taskDisplaySelective && runIntent !== "implement"`. The intent is classified by `classifyIntent(prompt)` on the server (same regex helper the preflight reasoner's `pickPipeline` uses), surfaced on every `ClientResponse.runIntent`, captured at `runAgent` entry, threaded through `NeedsToolCtx`. The classification is **sticky** for the run — complexity may upgrade mid-run but the visible-task gate doesn't reactively flip.

Why sticky:

1. **First impression matters.** If the box is hidden on turn 1 and flipped on later because complexity grew, the user reads it as a UI inconsistency, not a feature. Better to commit to the choice from the first response.
2. **`classifyIntent` is cheap + deterministic over `prompt` text.** No new state, no cache invalidation. Every response carries the same value.
3. **The internal-task indicator** (`· thinking through it` in the Header) covers the case where work IS happening behind the scenes on a non-implement run. Users see activity without the full multi-step UI.

**Composition with Phase 18 (when it lands):** Phase 18 will gate `taskPlan` EMISSION on the server side. Phase 19 owns the cli RENDER side. Both layers can ship independently; together they form defense-in-depth. Phase 19 doesn't require Phase 18 — even if a stray taskPlan slips through, the cli's gate hides it.

**Setting:** `taskDisplaySelective` in `sysbase.ts` (default `true`). Off-switch for users who prefer the pre-Phase-19 always-show behaviour.

**Key files (one source of truth per concern):**
- Server: `server/src/handlers/user-message.ts` + `server/src/handlers/tool-result.ts` set `clientResp.runIntent`
- Server type: `server/src/types.ts: ClientResponse.runIntent`
- CLI capture: `cli-client/src/agent/agent.ts` captures from initial + subsequent responses
- CLI event: `cli-client/src/agent/events.ts: intent_classified`
- CLI reducer slot: `cli-client/src/ui/hooks/useAgentEvents.ts: AgentEventState.runIntent`
- CLI gate (handleNeedsTool's task block): `cli-client/src/agent/agent.ts: taskDisplayGated`
- Header indicator: `cli-client/src/ui/components/Header.tsx: showInternalTaskIndicator`
- Setting: `cli-client/src/lib/sysbase.ts: getTaskDisplaySelective`

## Why investigate via commands, not file reads

- **Source:** plan `applied/2026-05-13-command-first-investigation.md`

The pre-Stage-1 default was *"batched `read_file` for exploration"*. Stage 1 flipped it to *"`run_command` first, `read_file` only when about to edit."* The user's framing: *"claude code doesn't just read files, it uses command line heavily with reasoning thats why claude code is accurate."* Three reasons the command-first default wins on accuracy, even when reading more files would feel safer:

**1. Commands return SHORT factual output the model can reason about; reads return long files the model skims and hallucinates against.**

`git status` returns 4 lines. `ls` returns 20. `grep -r symbol src/` returns 5-15 matches. The model holds the full output in attention and reasons about it directly. By contrast, a full `read_file` on a 400-line module forces the model to summarise mentally — which is exactly where hallucination shows up. The model "knows" the file imports `foo` from `./bar` even when it actually imports it from `./baz`, because the import line wasn't in the attention window the model used to form the mental model.

Empirically: the bugs that the Phase 11 awareness loop was designed to catch (`completion_claims_unwritten_files`, `intent_keyword_absent`, same-file thrashing) all show the same shape — the model formed a mental model from skimming long files and then operated against the mental model instead of the disk. Commands collapse that surface area.

**2. Commands are EXPLORATORY by design; reads are commit-shaped.**

`grep -r 'class Foo'` says "tell me everywhere Foo appears." `find . -name '*.config.*'` says "what config files exist?" The output drives the next question — *what does this mean? what alternative just got ruled out?* — and reasoning happens between commands. A `read_file` says "show me this exact file" — which presupposes the model already knows WHICH file is relevant. If the model picks the wrong file (or the most-recently-mentioned one, which isn't always the right one), the read returns confident wrong context. Reads reward correct-on-the-first-guess; commands reward iterative refinement.

**3. Commands expose the SYSTEM, not just the file.**

`git log -10 --oneline` shows recent intent. `npm list <pkg>` reveals version. `which node`, `node -v` answers env questions. `find . -name '*.test.*' | head` maps the test surface. None of those questions are answerable by `read_file` — they require the SYSTEM, not just text. The pre-Stage-1 default could only ever see files the model already knew about. The new default sees the project shape.

**The rules we keep from this discipline:**

- `read_file` is still in the tool list — kept, not removed. It's the right tool when *the file is identified and you're about to edit it*. The shift was prompt-level (default), not surface-level.
- Trivial tasks skip investigation entirely. *"Add a `console.log` to line 42"* doesn't need `git status`. The LLM is instructed to gauge depth (same pattern as `DEEP_REASONING_PROMPT`'s depth-awareness clause); the system caps via `getInvestigationBudget(complexity === "simple") = 1`.
- The safe-command allowlist (`isSafeReadOnlyCommand`) is the operational unlock — without it, every investigation command prompted the user for approval and the new default would have been unusable. The allowlist is regex-based and conservative; unknown commands fall through to the existing `ask` gate.

When to revisit: if telemetry (`investigationCommandsCount` in `usage.jsonl`) shows the average non-trivial run hitting <2 commands, the prompt directive isn't sticking. The lever is `task-guidelines.ts` + `investigation.ts` — the next pass should strengthen the framing rather than relax the budget. The budget is the safety net; the prompt is the steering wheel.

## Reasoner backend follows the main model, not the user's preference flag

- **Source:** plan `applied/2026-05-07-model-lock-and-portable-reasoning.md` (Stage D)

`pickReasonerBackend` defaults to **same-vendor reasoner when available**: claude-sonnet runs use Claude Haiku to reason, gemini-flash runs use Gemini Flash, and so on. The plan considered three alternative selection strategies and rejected each:

**1. User-pinned global preference** (e.g. `reasoning.preferred_backend = "gemini"` regardless of main model). Rejected because the dominant failure mode the plan was fixing — *"i used claude sonnet why it switches to gemini lol"* — applies to reasoners as much as main models. If a user picks claude-sonnet, the implicit contract is *"please use Anthropic for everything about this run."* Pinning the reasoner to Gemini globally violates that contract for users who explicitly switched away from Gemini.

**2. Always-cheapest-available** (pick whichever backend has the lowest $/token of those configured). Rejected because the cost difference between Haiku ($0.80/M input) and Gemini Flash ($0.075/M input) is real, but the variance in any given run's output is dominated by the main-model spend, not the reasoner. A 10× reasoner cost difference on 500-token Flash calls is rounding-error against an 8000-token Sonnet response. Optimising for cents-per-run reasoner cost over coherence-with-main-model is the wrong rank order.

**3. Round-robin across configured backends** (load-balance to avoid hammering one provider's rate limits). Rejected because reasoner calls are cached aggressively (sha256 over context); the throughput pressure is much lower than for main-model calls. Adding observability complexity ("which backend served this turn?") for marginal rate-limit headroom would obscure debugging without solving a real problem.

**The rule (in order of override):**

1. **Explicit `reasoning.backend` flag override.** Operators pinning a backend for testing / outage workaround. Honoured if its key is present; returns `null` (= legacy fallback) if not.
2. **Same-vendor match.** claude-* → anthropic (Haiku); gemini-* / swe → gemini; openrouter-routed → openrouter (with gemini preferred when available, since direct Gemini is historically the path).
3. **Walk other configured keys** as fallback in a sensible priority order (see the matrix in `architecture.md: ## Reasoner backends (model-aware)`).
4. **Null** when no backend has a configured key. Caller drops to legacy non-reasoning mode — same path the missing-`GEMINI_API_KEY` case has used since Phase 5.

The selection is **pure** (no LLM judgement, no probing, no fetch). Tests pass an explicit `env` snapshot so the matrix is unit-table-testable without env mutation. Pure helpers in `free-tier-policy.ts` are the canonical home for this kind of cross-cutting policy decision — see existing entry *Free-tier policy is a centralised module, not scattered checks*.

**Why this matters going forward:** When a future plan adds a new reasoner-capable backend (a hypothetical `mistral-backend.ts`, or a Bedrock-hosted Claude variant), the change is (1) a new backend module, (2) a new branch in `pickReasonerBackend`, (3) tests for the new branch. No call-site refactoring; no flag-default changes. The same-vendor heuristic is the design contract that makes the addition safe — if a future Mistral main model lands, `mistral-*` → mistral-backend is the obvious mapping, not a flag-driven user surprise.

## System-level enforcement beats prompt-level guidance for free models

- **Source:** plan `applied/2026-05-15-free-tier-quality-enforcement.md`

Across all 5 stages of free-tier quality enforcement, the recurring user feedback was *"prompts get ignored when models are confused or overloaded — adding more text to the system prompt won't fix it."* The plan committed to fixing every failure mode at the SYSTEM level — INJECTING directives into tool-result bodies (verify-after-write, mandatory self-review), REJECTING completions that violate the contract (server-side validation), and FORCING per-step / per-cadence checks the prompt-only path couldn't enforce.

**Why prompts alone fall over on free models:**

1. **Free models truncate, drift, and confuse.** Free OpenRouter routes (Llama, Mistral, openrouter-auto, gemini-flash-or) ship with shorter effective attention spans, more aggressive token truncation under load, and weaker instruction-following on multi-step contracts. Every additional system-prompt sentence is a sentence that might get dropped, mis-weighted, or contradicted by the closer turn-level prompt.
2. **Prompts are advisory, code is dispositive.** A handler that appends `═══ VERIFY THE LAST CHUNK ═══` to the next tool-result message forces the model to see the directive at the most-recent-attention position. A handler that filters write-tools out of the next response when self-review is due makes the contract MECHANICALLY enforceable, not aspirational.
3. **Failure modes compound.** When the model forgets one step, it tends to forget the next. The persistent task ledger (Stage 2) re-injects high-level subtask state into every system prompt, so even a model that drops 80% of the prompt sees the unfinished work each turn.

**The five concrete mechanisms the plan added:**

- Stage 1 — INJECTION: `═══ VERIFY THE LAST CHUNK ═══` block appended to the tool-result body for the next turn after writes (`server/src/services/post-write-verifier.ts`).
- Stage 2 — REPETITION: ledger of high-level subtasks rendered in every system prompt (`server/src/services/task-ledger.ts` + `prompt/sections/task-ledger.ts`).
- Stage 3 — INJECTION + REJECTION: `═══ REVIEW REQUIRED ═══` block fires on a cadence; server-side validation rejects writes during a review turn (`server/src/services/self-review-scheduler.ts`).
- Stage 4 — CADENCE CHANGE: heuristic divergence runs after EVERY tool result on free-tier, not just chunk boundary (`tool-result.ts` per-step block).
- Stage 5 — CROSS-CHECK: detect "said X did Y" disconnect between `reasoningChain` and the next action (`server/src/services/reasoner-action-checker.ts`).

**When this principle applies vs. when it doesn't:**

- APPLIES: any contract the model SHOULD follow but is observed to ignore on free-tier (verify writes, read before fix, plan before scaffold, etc).
- DOESN'T APPLY: behaviour that depends on the model's own judgement (which API to call, which file structure to use). Those are still prompt-shaped because there's no objective system-level oracle to check against.

A future stage that wants "the model should X" must answer: *what's the system-level enforcement?* If the only answer is "tell it harder in the prompt", expect the same failure mode to come back from a different angle on free-tier.

## Conservative heuristics — only flag unambiguous mismatches

- **Source:** plan `applied/2026-05-15-free-tier-quality-enforcement.md` (Stage 5 + carry-over from Phase 11)

The reasoner-vs-action cross-check (Stage 5) sits inside the awareness loop alongside ~7 other divergence categories. Its design point: *only fire on the UNAMBIGUOUS read-intent + write-tool case*. The inverse (write-intent + read-tool) is deliberately not flagged. Mixed intent in the reasoning passes through. Short reasoning passes through. Unsafe `run_command` is treated as `other` (no flag), not `write` (avoiding flagging install / build / migration commands).

**Why conservative:**

1. **The confidence-tracker decays multiplicatively.** Each fire deducts weight × severity-multiplier; multiple distinct categories piling up cross the off-course threshold (`awareness.threshold_off_course = 60` by default, +10 for free-tier). A noisy heuristic doesn't just produce noisy logs — it actively pushes the run toward the off-course modal, which interrupts the user. Cost of a false positive scales with how disruptive the downstream action is.
2. **One conservative signal composes; one greedy signal dominates.** Phase 11 deliberately tunes weights so no single heuristic can take a fresh run from on_track to blocked in one fire. A heuristic that flags too aggressively would either need a tiny weight (making it useless) or would dominate the tracker (making the other signals decorative).
3. **The agent will be wrong sometimes — that's fine.** The right comparison isn't "does this heuristic fire on EVERY case of bad behaviour" but "is the false-positive rate low enough that operators trust the signal". Conservative heuristics earn that trust; greedy ones lose it on the second false alarm.

**The carve-out rule** (re-stated for future heuristics):

- The mismatch the heuristic flags MUST be a case where a careful human reading the same data would also say "yes, that's clearly off". 
- If the mismatch is *probably* off — e.g. write-intent paired with a read tool, which is *usually* a setup pattern but *occasionally* a "I changed my mind mid-paragraph" — don't flag. Let it through. Other signals (per-step `same_action_repeated_in_session`, chunk-boundary verification gate, etc.) will catch the genuinely-bad cases via composition.

Concrete examples from the live code that follow this rule:

- `same_action_repeated_in_session` requires >2 occurrences in a 3-6 turn window. Below threshold passes through.
- `no_investigation_before_write` requires `complexity !== "simple"`. Trivial tasks pass through.
- `reasoning_action_mismatch` requires UNAMBIGUOUS read-intent + write-tool with no mixed signals.
- `intent_keyword_absent` requires the keyword to be in the INTENT_VOCAB whitelist. Generic English words pass through.

**When to consider a less-conservative variant:** if telemetry shows that a known-bad pattern fires very rarely under the conservative rule. The fix is then a SECOND heuristic with its own category, not a relaxation of the existing one (which would change the weight calibration the whole tracker depends on).

## Asymmetric chunk caps for free-tier (runtime tighten, not schema relax)

- **Source:** plan `applied/2026-05-07-phase-16-deep-reasoning-on-free-models.md` (Stage 5)

Free-tier runs use tighter chunk caps: `max_chunks_per_run` × 0.7 (12 → 8 chunks) and `chunkPlanBriefSchema.files.max(5)` runtime-sliced to 4. The asymmetry is the design point — we don't relax the schema cap for paid models, we only tighten the runtime slice for free-tier.

**Why tighten only at runtime, not at the schema:**

- The schema cap is a HARD invariant for the chunk-plan pipeline's prompt — "files MUST be 1-5 entries" is part of how the planner is instructed. Lowering it to 4 globally would constrain paid models for no benefit.
- The runtime slice is opportunistic — if the planner returns 5 files, free-tier slices to 4. If it returns 3, no slice happens. The slice is a ceiling, not a floor.
- Schema validation runs on the model output regardless of model tier; loosening it after the fact (allowing 6 for paid, 4 for free) would create two parsing modes. Single hard cap, asymmetric runtime ceiling.

**Why 4 not 3:**

- A paid-model chunk averages 3-4 files in practice (rationale-driven, not maxed). 4 is the plan's natural ceiling, just enforced.
- Dropping to 3 would force the planner to emit more chunks for the same work, increasing total Flash + main-model cost.

**Why 0.7 for chunk count:**

- 12 × 0.7 = 8.4 → floor 8. 0.6 (12 → 7) felt too aggressive; 0.8 (12 → 9) didn't differ enough from the default to matter.
- The cap is a runaway-loop guard, not a quality dial. 8 chunks of 4 files each = 32 files in flight, which matches what a free-tier run typically completes within the affordability ceiling (~15k tokens — see existing *Free-tier OpenRouter affordability ceiling is ~15k tokens* in `gotchas.md`).

When this needs to evolve: if telemetry shows free-tier runs frequently hitting the 8-chunk cap with incomplete output, the right move is splitting via more aggressive chunk_plan boundaries, not raising the cap.

## Error reasoning is an iterative chain, not a single-shot LLM call

- **Source:** plan `applied/2026-05-15-forced-error-reasoning-and-recovery.md` (Stage 1+2)

When a tool errors, the error reasoner runs an iterative paragraph chain (1-4 Flash calls, LLM owns the `done` flag) — not the single-shot `bugBrief` Phase 5 produces. The structured `bugBrief` shape (`symptom / suspectedBoundary / proposedFix`) stays for downstream consumers (divergence detector, bug_pattern memory) but is no longer the primary recovery artifact.

**Why iterative:**

1. **Errors are ambiguous on the first read.** `'ls' is not recognized` could be platform (cmd.exe vs PowerShell), missing PATH, wrong cwd, or a typo. Single-shot forces the model to commit on one hypothesis; iterative lets it surface the question another iteration would answer (`done: false` + the specific follow-up).
2. **Paragraphs surface in `<ReasoningPeek>`.** PR #83's plain-prose render path takes `reasoningChain[]` and shows it above the next command. Senior-engineer paragraphs are readable; a structured `bugBrief` is operational metadata, not deliberation. The user feedback that prompted this plan was about the agent NOT REASONING; surfacing paragraphs directly addresses that.
3. **Composes with `priorRecall`.** When `error_pattern` memory has a match, the chain's first iteration sees the prior fix and can confirm or revise. A single-shot LLM would either always trust the memory (overfitting) or never see it (uncomposed).

**Alternatives rejected:**

- *Single-shot structured `bugBrief` only* — what Phase 5 shipped. The user-reported failure mode is exactly that the brief was ignored. More forceful injection didn't help; the underlying problem is the model needs to deliberate, not consume a verdict.
- *Retry with the same prompt + nudge* — the agent's prompt is already the same; nudging doesn't change the deliberation. We needed a separate Flash-class call that ONLY thinks about the error.
- *Restructure the on_error bug pipeline to be iterative* — would have entangled error reasoning with the existing chunk_reflect / divergence pipelines. Keeping `error_reasoning` as its own pipeline kind lets it evolve independently.

The structured `bugBrief` stays because the divergence detector + bug_pattern memory need stable fields. Iterative paragraphs are the new live-recovery artifact; bug_pattern persistence happens via the existing path (`recordBugPattern`) when consecutive errors hit ≥ 2.

## INJECT + REJECT pairs replace prompt-level "please reason about errors"

- **Source:** plan `applied/2026-05-15-forced-error-reasoning-and-recovery.md` (Stage 3+4)

Forcing the agent to acknowledge a tool error is a two-step mechanical pattern, not a prompt rewrite. Stage 3 INJECTS the `═══ ERROR — REASON THROUGH THIS ═══` block at the END of the tool-result body (last thing the model reads before its response window). Stage 4 REJECTS responses that ignore it via `validateErrorAcknowledgement` + a reject-prompt re-call loop capped at 3 rejections per error.

**Why INJECT alone isn't enough:**

The block is the *most attention-relevant position* in the prompt, but free-tier models still skim past it ~25-30% of the time in observed runs. The block tells the agent what to do; the validator catches the case where the agent didn't do it. Same shape as Phase 15's confirmation gate (PR #75) — soft pressure + hard veto, composing.

**Why the validator is token-overlap, not LLM-judged:**

A second LLM call to judge whether the response engaged with the error would double-fire cost on every error turn AND introduce a different failure mode (judge model hallucinating that engagement happened). The 25% token-overlap threshold against the error vocab + rootCause is cheap, deterministic, and tuned conservatively — false-positive rejections (validator says "no ack" when there was) are caught by the 3-rejection cap. False-negative passes (validator says "ack happened" when it didn't) are caught by Phase 11 awareness's `same_action_repeated_in_session` heuristic on the next turn.

**Why 3 rejections, not 1 or 10:**

- 1 is too brittle — a one-paragraph reasoning chain can fail the overlap check by chance.
- 10 livelocks the run on a model that can't recover (free-tier sometimes hits a confidence cliff).
- 3 matches the existing `MAX_COMPLETION_REJECTIONS` cap (Phase 15) so operators have one number to internalise.

**Why the validator is server-side, not in the model adapter:**

The adapter is provider-agnostic plumbing. The validator needs the prior error context, the chain's `rootCause`, and the per-run rejection state — all server-side concerns. Keeping it in `tool-result.ts` colocates the soft pressure (inject) and hard veto (reject) so they evolve together.

## Error pattern memory records `run_command` only for v1

- **Source:** plan `applied/2026-05-15-forced-error-reasoning-and-recovery.md` (Stage 5)

`recordErrorPattern` only mines `run_command` failures-and-recoveries. `write_file`, `edit_file`, and `batch_write` recoveries are NOT recorded even though they could fail and recover similarly.

**Why:**

1. **`run_command` is the canonical case.** The user-reported failure (`ls -R` on Windows) is a shell-command portability issue. The fix (Windows equivalent vs Unix) is reusable across runs because shell flavour is stable per-machine. Recording it pays off immediately.
2. **File-write recoveries are too heterogeneous.** `write_file('src/foo.ts', ...)` failed → `write_file('src/foo/index.ts', ...)` worked is rarely "the same pattern next time" — paths are project-specific. Recording each one is noise.
3. **The recall scoring assumes one platform per signature.** Shell signatures are stable across runs on the same OS; file-system signatures (EACCES, ENOENT) vary too much by absolute path to score reliably.
4. **Memory entries cost space + recall time.** Phase 8's compaction caps the file at 100 KB. Filling it with low-signal write-recoveries pushes useful entries (preferences, decisions, original_intent) toward eviction.

Future stages can expand the recorder per tool kind when telemetry shows a class of recoveries that recurs (e.g. `npm install` failures with a specific node version → workaround). The schema doesn't need changing — `failedTool` + `errorClass` are already discriminators in the entry's content.

**Alternatives rejected:**

- *Record every tool failure regardless of recovery* — defeats the purpose. The signal is "this fix worked", not "this thing failed".
- *Auto-execute the recalled fix* — too risky. The model decides; the recall just surfaces the prior fix to the reasoner. Removing model agency on retries would compound a stale memory into a wrong action.
- *Cross-machine memory sync* — explicitly out of scope. Per-platform signatures are inherently per-machine; cross-syncing would require a normalisation layer that has no obvious right answer (PowerShell vs cmd.exe semantics differ even within Windows).

## Project-init reasoning is a separate pipeline, not folded into preflight

- **Source:** plan `applied/2026-05-15-agent-runtime-fixes-and-project-init-reasoning.md` (Stage 1)

Repo-shape classification (`empty / small / existing-small / existing-large`) lives in its own `project_init` pipeline that fires BEFORE the preflight reasoner. It is NOT a sub-step of preflight, NOT extracted from the implement-brief's metadata, and NOT inferred from the directory tree at prompt-build time.

**Why:**

1. **Different concerns.** Preflight asks *"what should we build and how"*. Project-init asks *"what is on disk RIGHT NOW"*. Mixing them dilutes each — preflight's iterative chain currently has six rubric steps, none of which classify the repo. Adding a seventh step would push the chain past the cap on most runs.
2. **Different consumers.** Preflight feeds the main model's prompt. Project-init feeds *both* the main model's prompt (via the PROJECT STATE block) AND the action-planner's skip list (via `setConfigSkipList`). Two distinct downstream wirings.
3. **Different cache shape.** Preflight cache keys on `(prompt, model, sysbasePath)`. Project-init cache keys on `sha256(sortedFileList)` — same prompt + same repo state → same brief, even across different prompts. Merging the cache logic would force one cache to do two jobs.
4. **Different default action on null.** Preflight null falls through to the legacy single-pass code path. Project-init null falls through to *no skip list* (action-planner still hijacks). The fallback semantics differ; embedding in preflight would entangle them.

**Alternatives rejected:**

- *Add a `repoState` field to the existing implement brief* — would have meant teaching every implement-brief consumer (recordImplementSummary, divergence detector, etc.) about the new field. Net loss vs a clean new pipeline.
- *Detect repo state purely from heuristics (file count threshold + manifest presence)* — heuristics work for the obvious cases but miss monorepos (root looks empty, packages/ has everything) and stub projects (a single README + .gitignore could be either). The LLM call lets the rare case get the right answer.
- *Defer until the agent encounters confusion* — too late. The action-planner's config-search hijack fires on the FIRST tool call. The classification has to be available before any tool runs.

## 0-hit web search is a recovery situation, not a success

- **Source:** plan `applied/2026-05-15-agent-runtime-fixes-and-project-init-reasoning.md` (Stage 2)

A `web_search` returning an empty `results: []` array is now treated as a tool error with category `web_search_empty` — not a success. The cli executor stamps `_errorCategory: "web_search_empty"` + a recovery hint on the result, and the existing Stage 3/4 error-reasoning chain catches retries.

**Why:**

The user's failure repro:

> ▸ search web "tsconfig.json configuration 2026"
> ● WebSearch — 0 hits
> │ No tsconfig.json configuration data was found in the search results. Please provide the desired configuration details or a source link.

Treating 0 hits as a success leaves the agent reading an empty `results` array and synthesising its own conclusion (here: "halt with a 'please provide' message"). The agent didn't know that 0 hits is a recoverable situation — it had no hint that *"use best-practice defaults"* or *"reformulate"* were valid pivots.

**Alternatives rejected:**

- *Silent 0 hits as a success the agent has to interpret* — what we shipped before. Demonstrated to dead-end.
- *Retry-with-fallback-query automatically* — too magic. The model might want to retry, or to skip, or to give up on the verification entirely (best-practice defaults often suffice). Hardcoding a retry removes that agency.
- *Suppress `web_search` entirely on empty results* — would mean the cli silently fails the tool call, which is worse than surfacing the 0-hit and letting the model decide.
- *Add a new tool category `web_search_recovery`* — over-engineered. The existing error-classification taxonomy already has the `_errorCategory` mechanism; adding one more enum value with one more hint reuses all the existing plumbing.

The hint surfaces THREE recovery options (reformulate / use defaults / NEVER halt) so the model has to pick one. The Stage 4 ack-validator catches same-query retries and rejects them — the model can't satisfy the gate by repeating the failed query verbatim.

## Reasoning peek truncates by default; `r` toggles full view

- **Source:** plan `applied/2026-05-15-agent-runtime-fixes-and-project-init-reasoning.md` (Stage 3)

ReasoningPeek renders at most `MAX_PARAGRAPH_LINES = 3` paragraphs, each capped at `MAX_PARAGRAPH_CHARS = 180`. The user can press `r` (or `Ctrl+R`) to expand to the full chain.

**Why not show everything by default:**

1. **Screen real estate.** A 5-paragraph chain at full length pushes 20+ lines of muted text above the spinner. The peek is meant to be a glance, not a wall.
2. **Tool cards + reasoning peek + spinner together** already eat a meaningful chunk of the visible region. Truncated by default keeps the active turn visible.
3. **Power-user signal.** Expanding the peek is a tell that the user is actively debugging. Telemetry on `RunSummary.reasoningPeekExpansions` over time tells us whether the truncation cap is right — high values = users need more context per glance.

**Why `r` instead of `Tab` / `Space` / `Enter`:**

- `Tab` / `Enter` are reserved by the text input field for autocompletion and submission.
- `Space` would conflict with normal typing.
- `r` is mnemonic for "reasoning" and doesn't collide with anything else Ink-side.
- `Ctrl+R` is added as an alias because the user explicitly asked for it. Some terminals capture `Ctrl+R` for reverse-search-history but in Ink mode the cli owns the input loop.

**State resets on new brief emissions** so a fresh chain doesn't open in expanded mode unexpectedly. The user re-presses `r` if they want to see the new one. Tracked via `useRef(brief.key)` to avoid React's stale-closure trap.

## Normaliser synthesises reasoningChain from singular reasoning when needed

- **Source:** plan `applied/2026-05-16-reasoning-chain-provider-parity.md` (Stage 1)

When the model returns `response.reasoning` (singular string, legacy field) but NOT `response.reasoningChain[]` (array, new structured field), the normaliser synthesises a single-element chain from the trimmed singular value. Done in `resolvePerTurnReasoningChain(normalized)` for both `needs_tool` and `completed` envelopes.

**Why:**

The cli's live `<ReasoningPeek>` only refreshes when `perTurnReasoningChain` is a non-empty array. Provider-parity reality: models served via OpenRouter / Anthropic (especially CJS-shaped or smaller free-tier ones) populate `reasoning` instead of `reasoningChain[]`. Without synthesis, the peek stays stuck on the FIRST brief of the run (`project_init` / `intent_classification`) because no later turn produces a chain.

**Alternatives rejected:**

- *Trust the prompt-level directive alone* — Stage 2 strengthens the directive but free-tier models still skim past it ~25% of the time. The synthesis is the safety net.
- *Drop the structured field entirely; always render `reasoning`* — loses the per-paragraph multi-step structure on models that DO emit chains correctly. Structured wins when available.
- *Provider-specific shims (one synth per provider)* — over-engineered. The single helper applies uniformly because all three providers route through `parseJsonResponse` → `mapNormalizedResponseToClient`.

**Composition:** Stage 2's MANDATORY directive shifts the distribution toward structured emission; Stage 1's synthesis catches the residual. Stage 4 telemetry (`reasoningChainEmittedTurns` vs `reasoningChainSynthesisedTurns` in `RunSummary`) tracks the ratio over time so future tuning can target whichever side dominates.

**Critical sibling fix:** Stage 3 found two server-side overrides in `base-provider.ts` (weak-completion + tool-gate) that were dropping the chain when they fired. Both now carry it forward via spread. Without this, the override would replace `reasoning` with its own hardcoded string AND clear the chain — the cli would see only the override's pre-written explanation, never the model's actual deliberation about WHY the override fired.

## Sysflow infra errors halt the agent — they're not user-machine bugs

- **Source:** plan `applied/2026-05-16-server-hardening-and-error-source-distinction.md` (Stage 2)

Every error envelope carries `errorSource: "sysflow_infra" | "user_machine" | "unknown"`. When set to `sysflow_infra`, the cli halts the run cleanly with a banner — the agent's recovery chain does NOT fire. Without this discriminator the agent would interpret "set GEMINI_API_KEY in server/.env" (in an OpenRouter credit-exhaustion error) as a fix it should perform IN THE USER'S PROJECT DIRECTORY. The user reported the agent literally trying to mutate `server/.env` relative to their cwd to "fix" sysflow's exhausted credit pool.

**Why a typed discriminator beats message-pattern matching:**

1. **Provider-agnostic.** OpenRouter / Anthropic / Gemini all surface quota errors with different message formats. A typed flag set at the provider's failure site survives normalisation without each downstream consumer needing to know every provider's error vocabulary.
2. **Override-safe.** Stage 2's tag survives the SSE event re-throws + the normaliser mapper without depending on string preservation. Stage 1 of the reasoning-chain plan showed how easily strings get rewritten by server-side overrides.
3. **Telemetry-friendly.** `RunSummary.sysflowInfraErrorCount` aggregates cleanly. Spike across runs = API keys / quotas are draining.

**Alternatives rejected:**

- *Just check the error message for "credits" / "auth" / "401"* — already had a partial version in `state-machine.ts`. The user's repro slipped through because OpenRouter's credit-exhaustion error includes the word "rate" — the rate-limit matcher caught it first and triggered `rate_limit_retry`, fall-back retry, and eventually the agent recovery chain.
- *Treat ALL 5xx from sysflow as sysflow_infra* — too coarse. A 5xx during the chunked-reasoning loop might be a transient (worth one retry) — current logic distinguishes via Stage 3's `classifyNonRetryable` body check.
- *Auto-switch models on sysflow_infra (OpenRouter exhausted → fall to Gemini)* — explicitly rejected by the prior `model-lock-and-portable-reasoning` plan. Users want their model choice respected; auto-fallback confused them ("i used claude sonnet why it switches to gemini lol").

## Cli refuses to retry 5xx with diagnostic bodies

- **Source:** plan `applied/2026-05-16-server-hardening-and-error-source-distinction.md` (Stage 3)

`cli-client/src/lib/server.ts` exports a `NonRetryableError` subclass + `classifyNonRetryable(text)` pure helper. The retry loop in `callServer` / `callServerStream` checks `instanceof NonRetryableError` to skip — independent of message format. The classifier matches:

- Postgres constraint violations (canonical `violates (not-null|unique|foreign key|check) constraint` phrasings)
- App validation codes (`validation_failure` / `ValidationError` / `invalid_payload` / `malformed_response`)
- Server-tagged `"errorSource":"sysflow_infra"` (Stage 2's discriminator)

**Why instanceof, not message substring:**

The previous retry classifier used `!(err as Error).message?.includes("Server error")`. SSE-event error paths throw the raw error body without that conventional prefix, so the substring check failed and the loop retried. The user's repro hit this exact path: server returned 500 via SSE → SSE handler threw raw PG error body → outer catch didn't see "Server error" → retried 3x against an unrecoverable DB constraint.

`instanceof NonRetryableError` survives every re-throw and parse round-trip. The signature field carries telemetry (which signature matched) without depending on the message format.

**Pattern specificity matters.** The classifier requires canonical PG phrasings (`violates ... constraint`), not bare `constraint` (which appears in unrelated stack traces). Test coverage explicitly pins both the positive cases AND the should-NOT-match cases (generic `Internal Server Error`, empty bodies, connection errors, `constraint` in unrelated context). Drift-protected.
