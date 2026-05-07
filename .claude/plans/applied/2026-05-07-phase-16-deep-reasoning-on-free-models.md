# Phase 16 — Deep reasoning on free models: chained Flash + complexity-aware orchestration

- **Created:** 2026-05-07
- **Status:** implemented (2026-05-07)
- **Scope:** The system already runs 7 reasoning triggers per run (preflight / chunk_plan / chunk_reflect / divergence / on_error / on_completion / self_invoked). All 7 are **one-shot Flash calls** — none chains its output into a follow-up reasoning step. The system also has *zero* free-tier-model adaptation outside Phase 11's confidence threshold bump. Phase 16 adds chained reasoning + free-tier-aware orchestration so the cheap models we depend on think as deeply as a paid model would.

## Goal

Premium paid models reason deeply by default. Free OpenRouter models don't — they pattern-match and rush. The system already has all the pieces to compensate (Flash for cheap reasoning, chunk loop for structured execution, awareness for divergence) but composes them naively: one Flash call per trigger, take its output as gospel, hand to the main model.

After Phase 16:
1. **Reasoning chains.** Where it matters most (preflight implement on a non-trivial task, divergence verdict on free-tier), the first Flash brief feeds a SECOND Flash call that elaborates. Two ~300-token calls cost less than one ~600-token call would on most providers and produce strictly better structure.
2. **Free-tier orchestration.** When `isFreeTierModel(mainModel)` is true, the reasoning depth is automatically dialled up — extra elaboration calls, stricter divergence cadence, more conservative chunk caps. The bump-by-+10 pattern already in `confidence-tracker.ts` becomes a generalised `freeTierBoost` shape spread across triggers.
3. **Complexity-aware depth.** `analyzeTaskComplexity()` already exists in `completion-guard.ts` (today only used post-hoc) — Phase 16 invokes it pre-flight, so the depth-of-reasoning is proportional to the difficulty class.

This phase composes additively with Phase 15 (memory) and Phase 18 (pre-task confirmation) — same Flash pipelines, same memory-store, same model-routing helpers. The only thing changing is *when* and *how often* we call them.

## Context from knowledge base

- `architecture.md: ## Chunked reasoning loop (Phase 10)` — the existing trigger inventory; Phase 16 adds chained calls within these triggers, doesn't add new triggers.
- `architecture.md: ## Awareness loop (Phase 11)` — the divergence pipeline + the `isFreeTierModel` + `FREE_MODEL_SENSITIVITY_BUMP = 10` pattern Phase 16 generalises.
- `decisions.md: ## Planner ↔ reflector are additive, not merged` — same logic applies to chained reasoning (separate concerns, separate calls). Phase 16 chains within a concern (e.g. a deeper "why this stack" follow-up to the initial implement brief), not across concerns.
- `decisions.md: ## Awareness signal sources are peers, not chained` — peers stay peers. The chain Phase 16 introduces is *within* a single signal source (preflight, divergence), not across them.
- `gotchas.md: ## Reasoning cache key was prefix-truncated → chunk plans aliased` — the chained second call's input differs from the first's, so the cache key naturally diverges. Don't add cache-key shortcuts that re-introduce aliasing.
- Phase 11 plan `applied/2026-05-06-phase-11-awareness-and-recovery.md` — the original `isFreeTierModel` introduction; this phase extends it.

## Affected files

### New chained reasoning helper
- `server/src/reasoning/chain.ts` (new) — small helper `runReasoningChain(stages: ReasoningStage[]) → ChainedBrief`. Each stage receives the prior stage's brief + the original payload; the final stage's output is what downstream consumes. Telemetry stamped onto `RunSummary.flashCallsCount`.

### Chained pre-flight (the headline win)
- `server/src/handlers/user-message.ts` — when preflight returns `implement` with confidence < HIGH on a free-tier model, run a second-stage `implement_elaborate` Flash call that produces:
  - `whyThisApproach: string` (1-3 sentences)
  - `whyNotAlternative: string[]`
  - `preconditions: string[]` (e.g. "cwd is a git repo", "package.json exists")
  - `confidence: HIGH | MEDIUM | LOW` (re-scored)
  
  If the elaboration's confidence is now MEDIUM-or-better, proceed; otherwise re-prompt or escalate.

### Chained divergence
- `server/src/services/divergence-detector.ts` + `server/src/reasoning/pipelines/divergence-pipeline.ts` — when the heuristic + verification gate signals add up to "probably off-course but unsure" AND model is free-tier, run a *second* divergence call that compares structured file-deltas against the LITERAL prompt (Phase 15's original-intent reader). One verdict → one second-look → final verdict.

### Free-tier orchestration constants
- `server/src/services/free-tier-policy.ts` (new) — central place for the existing `isFreeTierModel` + new constants:
  - `FREE_MODEL_SENSITIVITY_BUMP` (already 10; moved here from `confidence-tracker`)
  - `FREE_TIER_PREFLIGHT_ELABORATION = true` (gate the chained preflight)
  - `FREE_TIER_DIVERGENCE_CHAIN_THRESHOLD = 50` (heuristic+gate score below which the second divergence fires)
  - `FREE_TIER_CHUNK_CAP_TIGHTEN = 0.7` (multiplier on `max_chunks_per_run`)
  - `FREE_TIER_CHUNK_FILES_TIGHTEN = 4` (instead of 5)
- `server/src/services/confidence-tracker.ts` — now imports from `free-tier-policy.ts`; the old constant export becomes a re-export for back-compat.

### Pre-task complexity hook
- `server/src/handlers/user-message.ts` — call `analyzeTaskComplexity(prompt)` IMMEDIATELY after intent classification, BEFORE preflight runs. Pass result into preflight context as `taskComplexity: "simple" | "medium" | "complex"`.
- `server/src/services/completion-guard.ts: analyzeTaskComplexity` — function stays where it is; just gets a new caller. Possibly a small refactor: split into `analyzeTaskComplexity()` (pure) and `validateCompletionAgainstComplexity()` (post-hoc) so pre-flight callers don't accidentally drag in the validation wiring.

### Schema additions
- `server/src/reasoning/reasoning-schema.ts` — add the elaboration brief fields to a new `implementElaborationBriefSchema`. Keep them additive; existing implementBrief unchanged.

### Tests
- `server/src/reasoning/__tests__/chain.test.ts` (new) — `runReasoningChain` happy path, error in mid-stage propagates correctly, stage 2 gets stage 1's output.
- `server/src/services/__tests__/free-tier-policy.test.ts` (new) — `isFreeTierModel` matrix; constants present; back-compat re-export from confidence-tracker still works.
- `server/src/handlers/__tests__/user-message.test.ts` (extend) — chained preflight fires on free-tier + LOW; doesn't fire on paid + HIGH; complexity classification routes the right way.
- `server/src/services/__tests__/divergence-detector.test.ts` (extend) — second-look fires on the borderline case; doesn't fire on a clear off-course or clear on-track.

## Migrations / data

N/A. Pure runtime additions. The new `implementElaborationBrief` becomes part of the reasoning envelope but is optional.

## Hooks / skills / settings to update

- New flag namespace: `reasoning.chained.*`
  - `reasoning.chained.preflight_elaboration_enabled` (default `true`)
  - `reasoning.chained.divergence_second_look_enabled` (default `true`)
  - Both are off-switches — the first stage is unchanged; only the chained second stage is gated.
- `.claude/knowledge/architecture.md` — update the Phase 10 chunked-loop diagram to show the optional chained-preflight branch.
- `.claude/knowledge/decisions.md` — entry for "chain within a concern, peer across concerns" once implemented.
- No `.claude/hooks/` changes.

## Dependencies

- Zero new npm packages.
- No new env vars; all gating via the new flags.
- Implicit: `GEMINI_API_KEY` must be set for the chained calls to actually execute. Without it, the flag is effectively false (degrades to single-stage like today).

## Risks & mitigations

- **Doubles Flash call count on free-tier preflight + chained divergence.** Mitigation: gate elaboration on confidence < HIGH so HIGH-confidence preflights don't re-call. Cap chained divergence to ≤ 1 second look per chunk. Net telemetry target: free-tier `flashCallsCount` ≤ 1.7× current (we set ≤ 1.5× for Phase 11 and stayed under).
- **Free-tier rate limits could push `429 Resource has been exhausted` errors more often** with extra Flash calls per run. Mitigation: existing retry budget (`task-reasoner.ts` already handles this) absorbs occasional 429s; chained call inherits it. If sustained 429s start, the flag turns it off without code changes.
- **Chained preflight could "argue with itself" on truly ambiguous prompts.** Mitigation: cap elaboration depth at 1 (no third stage). Final stage's `confidence: LOW` triggers `ask_user` (existing path) instead of looping.
- **Complexity classifier was tuned for completion validation, not pre-flight gating.** Mitigation: keep the function pure; layer a thin pre-flight wrapper that maps `simple` → "skip elaboration entirely", `medium` → "elaborate when free-tier", `complex` → "always elaborate". Test the boundary cases (single-sentence question = simple = no elaboration; "build a full-stack app" = complex = elaborate even on paid).
- **Cache aliasing between stage 1 and stage 2 inputs.** Mitigation: each stage's payload is distinct (stage 2 includes stage 1's output verbatim); the existing sha256 hashContext in `task-reasoner.ts` keeps them apart by construction.

## Implementation order

### Stage 1 — `free-tier-policy.ts` central + complexity pre-flight call
1. Move `isFreeTierModel` + `FREE_MODEL_SENSITIVITY_BUMP` to `free-tier-policy.ts`. Re-export from `confidence-tracker.ts` for back-compat.
2. Wire `analyzeTaskComplexity()` to fire immediately after intent classification in `user-message.ts`. Stash result on `runContext`.
3. No behaviour change yet — this stage is plumbing.
4. Tests for the policy file + the new pre-flight call site.

### Stage 2 — `runReasoningChain` helper + `implementElaborationBrief` schema
1. Pure helper that takes a list of stages, runs them sequentially, returns the final brief.
2. Schema for the elaboration brief (`whyThisApproach`, `whyNotAlternative`, `preconditions`, re-scored `confidence`).
3. Tests for the helper in isolation.

### Stage 3 — Chained preflight on free-tier
1. Gate behind `reasoning.chained.preflight_elaboration_enabled` (default true).
2. Trigger condition: free-tier model AND preflight confidence < HIGH AND complexity ≥ medium.
3. Wire elaboration brief into `runContext.reasoningBrief` so the main model sees the deeper reasoning.
4. Tests: trigger matrix (paid+HIGH = no elaboration; free+LOW = elaboration; free+HIGH = no elaboration; free+MEDIUM+simple-task = no elaboration).

### Stage 4 — Chained divergence second-look
1. Same shape: `reasoning.chained.divergence_second_look_enabled`, gated on free-tier + borderline score (40 ≤ score ≤ 60).
2. Reuses Phase 15's `original_intent` reader for the second-look prompt anchor.
3. Tests: borderline case fires; clear off-course (≤30) skips second-look (already decisive); clear on-track (≥80) skips.

### Stage 5 — Tighten chunk caps for free-tier
1. `FREE_TIER_CHUNK_FILES_TIGHTEN = 4` and `FREE_TIER_CHUNK_CAP_TIGHTEN = 0.7` apply when free-tier.
2. Apply via existing config-resolution path in `chunk-state.ts` (read flag + free-tier multiplier).
3. Tests: free-tier resolves to lower caps; paid keeps existing.

### Stage 6 — KB docs + plan archive
1. `architecture.md` — chained-preflight branch on the chunked-loop diagram + "free-tier policy" subsection.
2. `decisions.md` — chain within a concern; complexity-routes-depth, not pipeline.
3. `gotchas.md` — capture any free-tier surprises that emerged during testing.

## Verification

Per stage: typecheck + npm test green.

End-to-end:
- **Test 1 — paid model preflight unchanged.** Set `OPENROUTER_API_KEY` for a paid model; run an implement prompt; verify `flashCallsCount` matches today's baseline (no elaboration ran).
- **Test 2 — free-tier preflight on complex.** Run `"build a full-stack postgres-backed e-commerce store"` against `openrouter-auto`; verify elaboration ran (telemetry reflects ≥ 2 preflight calls); verify the final main-model prompt includes `whyThisApproach`.
- **Test 3 — borderline divergence triggers second-look.** Seed a chunked run with mismatched stack; verify divergence pipeline fires twice (once initial, once second-look) on the chunk where score lands 40-60.
- **Test 4 — flag disables behaviour.** Set `reasoning.chained.preflight_elaboration_enabled = false`; rerun Test 2; verify single preflight call.
- **Test 5 — telemetry budget.** Across a representative free-tier run, assert `flashCallsCount` ≤ 1.7 × the same prompt's count on paid. Capture in `usage-log.ts` summary.

## Out of scope

- Multi-step *agent* reasoning (the agent thinking aloud across multiple turns). That's the main model's job; Phase 16 only adds chained Flash, not chained main-model turns.
- Streaming reasoning peek to the cli (Phase 14 deferred this; Phase 16 doesn't change it).
- Cross-run reasoning caches that persist between sessions.
- Tuning the elaboration prompt for specific free models. Generic `openrouter-auto` is the target; per-model tuning is a future phase if metrics show it pays off.
- Replacing the existing single-shot triggers. They stay; chain only layers on top when configured to.

## Completion notes

Shipped across 6 PRs (#54-59). Headline win lands in Stages 3-4: free-tier runs now get a forced second-look on confidence-MEDIUM-or-LOW preflights and on borderline divergence verdicts, plumbing both deeper analyses into the prompt the main model sees.

### Stages as designed → as shipped

- **Stage 1** (#54) — `free-tier-policy.ts` central + complexity pre-flight. `isFreeTierModel` + `FREE_MODEL_SENSITIVITY_BUMP` moved out of `confidence-tracker.ts`; Phase 16 stages 3-5 constants declared up front so each stage adds one call site, not its own knob. `analyzeTaskComplexity` now fires pre-flight in `user-message.ts` (was post-hoc only); existing post-hoc completion-validation site reuses the pre-computed value.
- **Stage 2** (#55) — `runReasoningChain` helper + `implementElaborationBriefSchema`. Pure orchestrator with dependency-injected runner so tests stub without monkey-patching. Schema additions (`"implement_elaborate"` pipeline + brief shape) wired through the envelope.
- **Stage 3** (#56) — Chained preflight on free-tier. The headline win. Gate `shouldRunPreflightElaboration` fires only on free-tier × (medium|complex) × (MEDIUM|LOW) × flag-on. Output renders as a "DEEPER REASONING" sub-block under the implement brief in the main model's prompt.
- **Stage 4** (#57) — Chained divergence second-look. Gate `shouldRunDivergenceSecondLook` fires only when first verdict score lands in [40, 60] on free-tier. Second verdict carries the first as `priorVerdict` in context; replaces the first when it returns.
- **Stage 5** (#58) — Tighten chunk caps for free-tier. Three new pure helpers (`resolveMaxFilesPerChunk`, `resolveMaxChunksPerRun`, combined `resolveChunkCaps`). Wired at the cap-check + both `chunk_plan` slice sites. Schema cap stays 5 (paid is a no-op slice); free-tier runtime ceiling is 4 files / 8 chunks.
- **Stage 6** — this PR: KB docs (architecture.md adds the Phase 16 section with a 3-zone diagram + key-files index; decisions.md gains 3 entries on chain-within-a-concern, centralised free-tier policy, asymmetric chunk caps) + plan archived to `.claude/plans/applied/`.

### Telemetry from the run

- Server tests: 332 → 395 (+63 across the 6 PRs).
- CLI side untouched — Phase 16 is server-only.
- Verified end-to-end manually: a free-tier run with confidence-MEDIUM preflight on a complex prompt fires the chained elaboration; a borderline divergence verdict (score=50) fires the second-look; chunk_plan briefs return ≤4 files when model matches `isFreeTierModel`.
- The plan's free-tier overhead target (≤ 1.7× current `flashCallsCount`) is observable via `usage-log.ts`. Real-world ratio depends on how often free-tier preflights land below HIGH; will measure once production telemetry from Stages 3-4 accumulates.

### Deferred (cleanly, with hooks in place)

- **Per-model elaboration prompt tuning.** Generic `openrouter-auto` is the target today. If telemetry shows specific routes (LLaMA, Mistral) need different elaboration prompting, add a model-specific dispatch in `pipelines/index.ts: getPipelineSystemPrompt`.
- **Free-tier-aware completion-guard tuning.** `analyzeTaskComplexity` is now pre-flight (Stage 1); a future phase could tune the complexity → cap mapping per free-tier.
- **Chained on_error reasoning.** Today on_error is a single Flash call producing a bug brief. A second-look on the bug pipeline (especially when the first hypothesis disagrees with the chunk_reflect issues) could improve recovery on free-tier. Reuse `runReasoningChain`.
- **Cross-stage cost dashboards in the cli.** `flashCallsCount` is logged per run but not surfaced in the cli. Phase 14's `<RichSpinner>` overlay already shows tokens; adding flash-call count is a one-line addition once telemetry is being read at render time.

### Phase 16 + memory composition

Phase 15 wired memory's active-confirmation loop. Phase 16's chained reasoning consumes memory naturally:

- The Stage 3 elaboration call doesn't currently read memory directly, but its output (re-scored confidence + preconditions) influences which entries the model uses, which Phase 15's `applyMemoryFeedback` then confirms / contradicts on the response side.
- The Stage 4 divergence second-look uses `pickDivergenceAnchor` (Phase 15 Stage 5), so the second look anchors on the canonical recorded prompt the same way the first does.
- The Stage 5 chunk caps don't touch memory.

A future stage could explicitly thread `recallForReasoning({kind: "implement"})` into the elaboration's context so the second look benefits from prior implement-summary entries — currently the elaboration sees only the preflight brief + user prompt. Out of scope for Phase 16 since the wins were already substantial without it.
