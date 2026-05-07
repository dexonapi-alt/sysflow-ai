# Phase 15 — Memory handling: never-stale knowledge + cover-what-it-did

- **Created:** 2026-05-07
- **Status:** implemented (2026-05-07)
- **Scope:** The Phase 8 memory subsystem (storage / validators / recall / compaction) is built and tested, but the *active* anti-staleness loop and several record-what-actually-happened call sites were never wired. Phase 15 closes those gaps so memory entries stay fresh on their own and so every Phase 7 / 10 / 11 outcome ends up in `.sysflow-memory.md`.

## Goal

Make the memory store earn its name. Today the system can READ memory and INJECT it into prompts, but very little gets WRITTEN, and nothing actively **confirms** entries (so old entries grow stale silently) or **contradicts** them (so wrong entries keep injecting). After Phase 15, each agent run should:

1. Record what was decided / changed / corrected as it happens (broaden the existing recorder coverage).
2. On every recall, the agent should be told which entries to *confirm* (matched the conversation) and which to *contradict* (the conversation disagreed).
3. Confirmed entries refresh `lastConfirmedAt + useCount`. Contradicted entries trip the 2-hit kill.
4. Phase 11's divergence detector compares against `original_intent` so memory becomes load-bearing for the awareness loop, not just decoration.

End state: a 60-day-old entry that's been confirmed on three runs is treated as load-bearing; a 5-day-old entry the agent disagreed with twice gets killed.

## Context from knowledge base

- `architecture.md: ## Living CLI (Phase 12)` — memory entries surface in the CLI via the LEARNED_MEMORY prompt section; UI changes here would ripple to that section.
- `architecture.md: ## Awareness loop (Phase 11)` — the divergence pipeline reads from `original_intent` *conceptually*, but the actual code path doesn't read memory yet (verified via grep). Phase 15 wires that.
- `decisions.md: ## chunk planner cap of 5 files per chunk` — chunk_summary entries land per chunk; this stays.
- `gotchas.md: ## Reasoning cache key was prefix-truncated → chunk plans aliased` — relevant because the cache key for memory recall must remain content-hashed; do not regress to slice-based hashing.
- Phase 8 plan `.claude/plans/2026-05-02-phase-8-persistent-reasoning-memory.md` — original spec; treat that file as the source of truth for what was *intended*. Phase 15 is the "what's left to wire" follow-up.

## Affected files

### Wire missing recorder call sites
- `server/src/handlers/user-message.ts` — `recordDecision()` is imported (line ~22 per Investigator 1) but never called. Wire it: when preflight returns a non-LOW confidence implementBrief / decisionBrief with a clear "decision" string, record it. Same for bugBrief.
- `server/src/handlers/tool-result.ts` — wire `recordBugPattern()` on the tool-error path (today only the legacy console renderer prints the error; the memory recorder is unhooked). Wire `recordCorrection()` when an `awarenessChoice` resolution fires (user picked redirect / backtrack — that's a recorded correction).
- `server/src/services/divergence-detector.ts` — when divergence emits `intent_keyword_absent` or `llm_off_track`, AND a relevant memory entry was recently confirmed, record an explicit `noteContradiction()` against that entry id.

### Active confirmation loop (the big new piece)
- `server/src/providers/prompt/sections/learned-memory.ts` — extend the rendered section with a tiny *contract block* the model is asked to fill in. Today the section emits `[abc123] kind: content` lines; Phase 15 changes it to also accept (in the model's response JSON) a small `memoryFeedback: { confirmed: ["abc123","def456"], contradicted: ["xyz789"] }` map.
- `server/src/providers/base-provider.ts` — extract `memoryFeedback` from the response (similar to how `taskPlan` is extracted today around line 872). Pass to a new helper `applyMemoryFeedback(feedback)`.
- `server/src/memory-store/index.ts` (new export) — `applyMemoryFeedback({confirmed, contradicted})` calls `noteAgreement(id)` for each confirmed and `noteContradiction(id, reason)` for each contradicted. This is the missing call site for both.

### Original-intent reader (Phase 11 follow-through)
- `server/src/services/divergence-detector.ts` — currently the heuristic detector takes the user's prompt as input. Add a layer that reads `original_intent` via `getMemoryEntries({kind:"original_intent", recent:1})` and uses *that* as the canonical comparison anchor. `recordOriginalIntent()` is already wired (every new run); the reader half is missing.
- `server/src/reasoning/pipelines/divergence-pipeline.ts` — receive `originalIntent` from the detector and stamp it into the Flash prompt so the LLM compares files-modified against the LITERAL prompt, not the preflight brief's interpretation.

### Tests
- `server/src/memory-store/__tests__/feedback-loop.test.ts` (new) — `applyMemoryFeedback` calls noteAgreement / noteContradiction with the right args; missing-id is silently ignored; mixed feedback (some confirmed, some contradicted) is processed in order.
- `server/src/services/__tests__/divergence-detector.test.ts` (extend) — when an `original_intent` entry exists, the detector compares against it; when absent, falls back to the user prompt verbatim.
- `server/src/handlers/__tests__/user-message.test.ts` (extend) — the recorder call sites fire on the right preflight outcomes (HIGH/MEDIUM implementBrief → `recordDecision`; LOW → skip).

### Schema
- `server/src/reasoning/reasoning-schema.ts` — add the optional `memoryFeedback` field to the response normaliser. Backwards-compat: missing field is silently treated as no feedback.

## Migrations / data

N/A. The on-disk format of `.sysflow-memory.md` doesn't change. The `confirmation-tracker.ts` already tracks `useCount` / `lastConfirmedAt`; Phase 15 just starts calling its existing API.

## Hooks / skills / settings to update

- `.claude/knowledge/architecture.md` — when implemented, document the active-confirmation loop as part of the Phase 8 memory section.
- `.claude/knowledge/decisions.md` — when implemented, record the design choice (model-supplied feedback vs heuristic alignment).
- `.sysflow-memory.md` — gets richer organically as the recorder coverage expands. No breaking change.
- No `.claude/hooks/` or `.claude/settings.json` changes.

## Dependencies

- Zero new npm packages.
- New flag: `memory.active_confirmation_enabled` (default `true`). Off-switch in case the model's `memoryFeedback` field is noisy on free-tier; lets us disable injection without losing the recorder-coverage half.

## Risks & mitigations

- **Free-tier models may hallucinate `memoryFeedback` (confirming entries they didn't actually use, or contradicting accurate ones).** Mitigation: cross-validate — only honour a `confirmed` if the entry's content actually appears (substring or token-overlap) in the model's response text. Honour `contradicted` only when the response *explicitly disagrees* (not just omits). Helpers go in `applyMemoryFeedback`.
- **`original_intent` reader could blow up if the file isn't a git repo / no entries yet.** Mitigation: read returns `null` cleanly; detector falls back to user prompt verbatim — no behaviour regression.
- **Recorder over-coverage spams `.sysflow-memory.md`.** Mitigation: keep the existing LOW-confidence skip in `recordDecision()`; add a similar "skip if already recorded this run" dedup via the SHA256 ID the recorder uses. Compaction at 100KB still kicks in.
- **The contract block in the prompt eats tokens.** Mitigation: only render it when there are entries to feedback on (current section already conditional on `entries.length > 0`).
- **Free models could ignore the feedback contract entirely.** Mitigation: that's fine — recorder coverage half (the more impactful half) doesn't depend on the model. Active confirmation degrades to age-only safety, which is what we have today.

## Implementation order

Each step its own PR. Stages 1-2 are recorder coverage (no model contract change); Stages 3-4 are the active-confirmation loop; Stage 5 is the original-intent reader; Stage 6 is docs.

### Stage 1 — Recorder call sites
1. Wire `recordDecision()` in `user-message.ts` after preflight returns implementBrief/decisionBrief with confidence ≥ MEDIUM.
2. Wire `recordBugPattern()` in `tool-result.ts` on the tool-error path with the error class + tool name.
3. Wire `recordCorrection()` on awarenessChoice resolution (user picked redirect or backtrack).
4. Tests: handler-level integration tests assert each call site fires on the right preflight + tool-result shapes.

### Stage 2 — Recorder dedup + LOW-confidence skip parity
1. Each new recorder pass runs through the existing SHA256 dedup so identical entries within one run don't double-record.
2. LOW-confidence skip parity: bugBrief / decisionBrief get the same skip rule that implementBrief already has.

### Stage 3 — `applyMemoryFeedback` helper
1. New export in `memory-store/index.ts`. Calls `noteAgreement` / `noteContradiction`.
2. Cross-validation guards (substring / overlap check before honouring `confirmed`; explicit-disagreement check before honouring `contradicted`).
3. Tests for the helper in isolation.

### Stage 4 — Wire memoryFeedback through the response path
1. Schema: add `memoryFeedback` optional in the response-normaliser.
2. base-provider extracts it after taskPlan extraction.
3. `applyMemoryFeedback` is called BEFORE the response is returned to the cli (so the entry-store updates before the next turn's recall runs).
4. Prompt section gets the `## Memory feedback contract` block when `entries.length > 0`.
5. Tests: end-to-end happy-path (model returns feedback → entries update); guard-rail (model fabricates → cross-validation rejects).

### Stage 5 — Original-intent reader for divergence
1. `divergence-detector.ts` reads the most recent `original_intent` entry per run.
2. Pass it through to `divergence-pipeline.ts` so the Flash prompt compares against the LITERAL ask.
3. Tests: detector test fixture seeds an `original_intent` entry, runs detector against drifted file set, asserts `intent_keyword_absent` fires on the LITERAL keywords (not the brief's interpretation).

### Stage 6 — KB docs + plan archive
1. `architecture.md` — extend the awareness section with the original-intent reader path.
2. `decisions.md` — entry for active-confirmation loop design (model-supplied feedback + cross-validation guards).
3. `gotchas.md` — capture "free-tier `memoryFeedback` hallucinations need cross-validation" if testing reveals more nuance.
4. Plan moved to `applied/` with completion notes.

## Verification

Per stage:
- `npm run typecheck` clean both sides.
- `npm test` — server suite grows by ~10-15 cases (recorder integration + feedback helper + divergence-with-original-intent).

End-to-end:
- **Test 1 — confirm bumps useCount.** Seed a `decision` entry in `.sysflow-memory.md`. Run a prompt that obviously aligns. Assert `useCount` incremented and `lastConfirmedAt` updated.
- **Test 2 — contradict trips the kill.** Same setup; run two contradicting prompts; assert the entry is now `contradicted` (compaction will evict it).
- **Test 3 — original_intent anchors divergence.** Start a run with prompt `"build a postgres-backed user API"`; have the agent write Mongoose code; verify the divergence detector fires on the LITERAL `postgres` keyword (read from the recorded `original_intent`), not on whatever the preflight brief paraphrased it as.
- **Test 4 — recorder coverage on a real implement turn.** Start a run; verify `recordDecision()` fired (memory has a new `decision` entry post-turn); verify `recordImplementSummary()` already-fired path is unchanged (no double-record).
- **Test 5 — free-tier hallucination guard.** Force-supply a fabricated `memoryFeedback` claiming entry X is confirmed; assert cross-validation rejects it because content didn't appear in the response text.

## Out of scope

- Memory across DIFFERENT projects (cross-cwd recall). Today recall is per-cwd; that stays.
- Cross-session preference learning (that's Phase 17).
- Memory-aware completion summary in the cli — the current cli renders memory bullets via the prompt-injection path; no UI work in Phase 15.
- New entry kinds beyond what Phase 8 already declared. The existing schema (`decision` / `summary` / `correction` / `chunk_summary` / `original_intent` / `preference` / `bug_pattern` / `implement_summary`) is enough.

## Completion notes

Shipped across 6 PRs (#48 → #53). All five planned subsystems landed; the planning investigation's one wrong claim ("`recordBugPattern` has zero call sites") was caught at implementation time and didn't add work.

### Stages as designed → as shipped

- **Stage 1** (#48) — recorder call sites. `recordDecision` wired at preflight + `routes/reason.ts` self-invoked path. `recordBugPattern` was already wired at the on-error path (Investigator 1 missed it; verified during implementation). `recordUserCorrection` wired on off-course backtrack/redirect with stable string shapes.
- **Stage 2** (#49) — recorder LOW-skip parity. Pushed the LOW-confidence guard from call sites into `recordImplementSummary` (via brief.confidence) and `recordBugPattern` (via a back-compat options bag). Future callers can't accidentally regress the rule. Dedup verification tests pinned the existing SHA256 entry-id mechanism's behaviour for the new write patterns.
- **Stage 3** (#50) — `applyMemoryFeedback` helper in isolation. Pure helpers `validateConfirmation` (≥30% token overlap, dash-split, stopword-stripped) and `validateContradiction` (response must contain `[<id>]`). Per-id audit log returns honoured + rejected lists for telemetry.
- **Stage 4** (#51) — wire `memoryFeedback` through the response path. Schema: `NormalizedResponse.memoryFeedback`. Extraction: pure `extractMemoryFeedback(json)` in base-provider after taskPlan. Apply call sites in both handlers gated on the new flag `memory.active_confirmation_enabled` (default true). Prompt section gained the contract block when entries are recalled.
- **Stage 5** (#52) — original-intent reader for divergence. Pure `pickDivergenceAnchor` chooses between current `run.content` and recalled longest `original_intent` based on a 30-char substantive threshold. Wired into both the heuristic detector and the Flash divergence pipeline. `/continue` and fix-request follow-ups now anchor awareness on the canonical recorded prompt.
- **Stage 6** — this PR: KB docs (architecture.md adds the active memory loop section + diagram; decisions.md gains 3 entries on model-driven feedback / asymmetric guards / longest-original-intent picker) + plan archive.

### Telemetry from the run

- Server tests: 271 → 332 (+61 across the 6 PRs).
- CLI side untouched — Phase 15 was server-only by design.
- Verified end-to-end manually: an agent run that uses recalled memory now bumps useCount; a run that contradicts (with `[id]` reference) advances contradictionCount; hallucinated feedback gets rejected at the cross-validation gate.

### Deferred (cleanly, with hooks in place)

- **Substring-overlap tuning for `validateConfirmation`** — 30% threshold is conservative; we can revisit if telemetry shows real-world overlaps clustering above or below it. The constant `CONFIRM_OVERLAP_THRESHOLD` is exported via `_CONFIG` for runtime tuning.
- **LLM-judged feedback** — instead of trusting the model's `memoryFeedback` self-report, a Flash call could second-guess. Out of scope: the cross-validation guards already do most of the work cheaper.
- **Per-chat-id `original_intent` scoping** — today `recordOriginalIntent` is per-cwd; for multi-task chats, scoping by chatId would prevent /continue from picking up the wrong project's intent. Not needed yet because chats are mostly single-task; revisit if multi-task chats become common.

### Phase 15 + Phase 11 composition

Phase 11's `original_intent` was always meant to be read by divergence; Stage 5 finally wires it. The flow is now: user prompt → `recordOriginalIntent` (Phase 11 Stage 3, always-on) → `recallForReasoning({kind:"original_intent"})` (Phase 15 Stage 5) → `pickDivergenceAnchor` → `detectDivergence` + Flash divergence pipeline. Memory is load-bearing for awareness, not decoration.
