# Awareness heuristic accuracy: stale signals + investigation count

- **Created:** 2026-05-18
- **Status:** in-progress
- **Scope:** Two visible heuristic-accuracy bugs from 2026-05-18 user testing — `intent_keyword_absent: express` fires even though `package.json` was just written WITH express as a dependency, and `no_investigation_before_write` fires even though the agent did 2× `list_directory` first.

## Goal

User-reported repro (2026-05-18, fresh Express scaffold prompt):

```
● Write(package.json)        ← package.json with "express": "^4..." just landed
⚠ confidence dipped — watching for drift
● Read(package.json)
╭── OFF COURSE ──────────────────────────────────────────────────╮
│ Evidence:
│   [major] user asked for express but no related files / mentions …
│   [minor] agent wrote files without running any investigation com…
```

Two distinct heuristic-accuracy problems:

### Problem 1 — `intent_keyword_absent: express` is stale

Stage 2 of the awareness-and-verification-correctness plan added structural-signal tier 2: `"express"` should match when `package.json` content includes `"express"`. But the modal evidence shows the signal anyway. Three hypotheses to diagnose:

- **(a)** Content snippet for `package.json` wasn't captured. `ingestToolResult` should have captured up to 1KB on `write_file` success. Did it actually fire on this write?
- **(b)** Timing — the detector ran BEFORE `ingestToolResult` finished. Or BEFORE the write_file's `success: true` was observed.
- **(c)** Stale signal — the heuristic fired on EARLIER turns (before `package.json` existed). The confidence-tracker's history retains those entries; the current modal-evidence slice shows them even though the CURRENT-turn detector now correctly returns `null` (= keyword satisfied).

`(c)` is the most likely cause. The signal STORE accumulates per-turn entries; once `intent_keyword_absent: express` is in history, it stays until the run terminates. The modal evidence is "what's in the recent history" not "what the LATEST turn observed".

### Problem 2 — `no_investigation_before_write` is too narrow

Same trace: the agent did `list_directory(.)` AND `list_directory(sysbase)` BEFORE writing anything. The heuristic still fires. Why? `investigationCommandCount` (in `divergence-detector.ts` input) only counts safe-read-only `run_command` invocations (per the command-first-investigation plan Stage 4). `list_directory` is a TOOL CALL, not a `run_command` — so it doesn't count.

The agent DID investigate. The heuristic doesn't recognize that form of investigation.

## Context from knowledge base

- `architecture.md: ## Awareness loop (Phase 11)` — heuristic detector design.
- `architecture.md: ## Awareness loop > Intent-keyword satisfaction is three-tier` — Stage 2 of awareness-correctness plan.
- `applied/2026-05-16-awareness-and-verification-correctness.md` Stage 2 — content-snippet capture lives in `context-manager.ts`.
- `applied/2026-05-13-command-first-investigation.md` Stage 4 — investigation-command-count heuristic.
- `decisions.md: ## intent_keyword_absent searches file content + structural signals, not just paths` — the three-tier contract.

## Affected files

### Problem 1 — stale-signal diagnostic + fix

- `server/src/services/divergence-detector.ts: detectDivergence` — add a per-run "satisfied keywords this turn" set + emit when keywords flip from absent → satisfied.
- `server/src/services/confidence-tracker.ts` — new auto-resolve path: when a signal's category fires THIS turn for keyword X but X is now satisfied, downgrade the prior entries for that keyword OR add a positive-counter that offsets the negative weight.
- ALTERNATIVE simpler fix: filter the modal-evidence slice to "only signals from the most-recent N turns" instead of the raw history. Tradeoff: less context for the user but no stale entries.

Recommended: ship the simpler "show only most-recent-turn signals in modal evidence" first (Stage 1). The deeper auto-resolve is harder to get right and the modal-evidence fix is the user-visible part anyway. Stage 2 (separate plan if needed) can tackle the score-decay side of the stale-signal problem.

### Problem 2 — broaden investigation count

- `server/src/services/divergence-detector.ts` — relax the heuristic's input. The plan's `DetectorInput.investigationCommandCount` only counts `run_command`. We need a parallel count of "investigation TOOL calls" — `list_directory`, `read_file`, `batch_read`, `search_code`, `search_files`, `file_exists` are all investigation activities.
- `server/src/handlers/tool-result.ts: buildDetectorInput` — count these tool kinds from the run-log alongside the safe-read-only `run_command` count.
- Treat them as equivalent for the purposes of the `no_investigation_before_write` heuristic (sum both counts).

## Implementation order

1. **Stage 1 — Modal evidence shows recent-turn signals only.** Diagnose Problem 1's path (a/b/c hypothesis) by adding a one-shot log line in `tool-result.ts` showing the captured content snippet for `package.json` + the detector's tier-by-tier verdict. Then implement the modal-evidence filter: show signals from the LAST detector invocation, not from history. ~6 tests.
2. **Stage 2 — Investigation count includes structured tool calls.** New `DetectorInput.investigationToolCount` field; `buildDetectorInput` populates from runLog. Heuristic sums both. ~5 tests.
3. **Stage 3 — Plan archive + KB.** Decisions entry on "investigation = run_command OR structured read-tool calls"; gotcha entry on "intent_keyword stale-signal trap". Plan archived.

Three stages = ~3 PRs.

## Verification

**Stage 1**

- Diagnostic log surfaces which tier (path / structural / content / null) the detector returned for `"express"` after `Write(package.json)` lands. Expected: `"structural"` once the snippet is captured.
- Unit: modal-evidence filter returns only signals with a timestamp / turn-index matching the most-recent detector run.
- Manual: re-run the user's Express scaffold prompt. Observe the off-course modal evidence DOES NOT include `intent_keyword_absent: express` once `package.json` has been written.

**Stage 2**

- Unit: `buildDetectorInput` populates `investigationToolCount` from runLog's `list_directory` / `read_file` / etc. entries.
- Unit: heuristic 7 (`no_investigation_before_write`) does NOT fire when `investigationToolCount > 0` even if `investigationCommandCount === 0`.
- Manual: re-run the user's Express scaffold prompt. Observe `no_investigation_before_write` no longer fires after the opening 2 `list_directory` calls.

## Out of scope

- Full confidence-tracker auto-resolve path (auto-clear signals when underlying condition flips). Deferred to a separate plan if the modal-evidence filter alone doesn't recover the trust signal.
- Adjusting heuristic weights. The fix is on the INPUT side (don't fire false positives), not the SCORING side.
- Cross-run signal persistence. Each run starts fresh; no need to plumb history through restarts.
