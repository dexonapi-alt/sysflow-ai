# Off-course modal display fixes

- **Created:** 2026-05-18
- **Status:** draft
- **Scope:** Two visible display bugs in the off-course modal that surfaced during 2026-05-18 user testing — duplicate signals in the evidence list, and `rollback to chunk -1` reading nonsensically when the per-step blocked path fires before any chunk has started.

## Goal

User-reported repro (2026-05-18, from a fresh Express scaffold prompt):

```
╭── OFF COURSE ──────────────────────────────────────────────────╮
│ Confidence dropped to 35/100
│ I think the run drifted from your ask. What should I do?
│
│ Evidence:
│   [major] user asked for express but no related files / mentions …
│   [minor] agent wrote files without running any investigation com…
│   [major] user asked for express but no related files / mentions …
│   [minor] agent wrote files without running any investigation com…
│
│  [c] continue (override — keep going)
│  [b] backtrack (rollback to chunk -1)
│  [r] redirect (give a corrected direction)
│  [q] cancel (collapse to continue — Esc also works)
╰────────────────────────────────────────────────────────────────╯
```

Two visible issues:

1. Same signal lines appear twice each — confidence-tracker stores one entry per turn the heuristic fires, and the modal's `signals.slice(-6)` slice surfaces them all even though they're the same complaint.
2. `rollback to chunk -1` reads as gibberish — the per-step blocked path correctly emits `lastGoodChunkIndex: -1` when no chunks have started yet, but the modal renders it literally.

## Context from knowledge base

- `architecture.md: ## Awareness loop (Phase 11)` — defines the off-course modal contract.
- `architecture.md: ## Living CLI (Phase 12)` — modal is raw-TTY per the Phase 12 deferred-Ink-port decision.
- `applied/2026-05-16-awareness-and-verification-correctness.md` — Stage 3 wires the per-step blocked path through the shared synthesis helper which produces `lastGoodChunkIndex: -1` for pre-chunk halts.

## Affected files

- `cli-client/src/cli/off-course-prompt.ts` — render path for both fixes.
- `cli-client/src/cli/__tests__/off-course-prompt.test.ts` — new tests for the dedupe + backtrack-wording helpers.

## Implementation order

1. **Pure helper `dedupeEvidenceSignals(signals)`** — collapse consecutive signals with the same `detail` (or same `category`) so the modal shows each unique complaint at most once. Preserve order; keep the FIRST occurrence's severity if they differ.
2. **Render-time conditional for the backtrack line** — when `evidence.lastGoodChunkIndex < 0`, either:
   - Hide the `[b] backtrack` option entirely (it can't do anything useful), OR
   - Reword to `[b] backtrack (no checkpoint yet — restart the run)` so it's at least honest.
   Recommended: HIDE the option. A no-op key in the modal is worse than fewer options. The cli's `classifyOffCourseKey` should still return `"backtrack"` for `b`/`B` so the keystroke isn't silently swallowed — instead, the executor's `rollbackToChunk(-1)` already returns `false` cleanly and warns the user; that path is the safety net.
3. **6 new tests** covering dedupe (with/without category collision), the conditional backtrack line, and the integration in the modal render.

## Verification

- Unit: `dedupeEvidenceSignals([same, same, same])` returns `[same]`.
- Unit: `dedupeEvidenceSignals([a, b, a, b])` preserves order, returns `[a, b]`.
- Unit: rendering with `lastGoodChunkIndex: -1` omits the `[b]` line.
- Manual: force a fresh-scaffold off-course state; observe the evidence list shows 2 unique entries instead of 4 duplicate ones, and the backtrack line is hidden.

## Out of scope

- Auto-expiring stale signals from the confidence-tracker history. Separate plan covers the deeper "stale signal" problem.
- Off-course modal Ink port. Phase 12 deferred decision stands.
