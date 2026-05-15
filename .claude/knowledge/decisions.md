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
