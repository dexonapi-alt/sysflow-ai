# Batch heading + permission-label width polish

- **Created:** 2026-05-18
- **Status:** implemented (2026-05-18)
- **Scope:** Two visible display bugs from 2026-05-18 user testing — permission-prompt label truncates mid-word for long run_command paths, and the batch-display heading reads `batch (N tools)` even when the dispatch is actually serial (run_command in the batch forces serial execution).

## Goal

User-reported repro (2026-05-18, mid-Express scaffold):

```
╭── PERMISSION ──────────────────────────────────────────────────────────────────╮
│ run_command node --check src/middleware/errorHandler.js
│
│  [a] allow once
│  [A] allow always for this (run_c
```

The `[A] allow always for this (run_command on node --check src/middleware/errorHandler.js)` line truncates mid-word at the box's right edge. Stage 5 sized the BOX correctly (`pickPermissionBoxWidth`) but the line itself isn't truncated to fit.

Same trace also shows:

```
╭── batch (3 tools)
│  ○ batch_read {"paths":[…]}
│  ○ run node --check src/middleware/errorHandler.js
│  ○ run node --check src/routes/productRoutes.js
```

`batch (3 tools)` is the heading — but `run_command` is in the SERIAL path (`isConcurrencySafe: false`). So this dispatch is actually 1 parallel `batch_read` + 2 serial `run_command` calls. The user reads "batch" as "parallel" by convention.

## Context from knowledge base

- `architecture.md: ## Premium CLI components (Phase 14)` — ActionCard + permission prompt visual.
- `applied/2026-05-18-ui-ux-polish-and-action-aware-spinner.md` Stage 5 issue #6 — width-aware permission prompt baseline.
- `decisions.md: ## ●-bullet ActionCards instead of bordered boxes` — visual vocabulary.
- `cli-client/src/agent/tool-meta.ts: partitionToolCalls` + `getToolMeta` — source of truth for which tools are concurrency-safe.

## Affected files

- `cli-client/src/cli/permission-prompt.ts` — clamp the long `[A] allow always …` line to the modal's resolved box width.
- `cli-client/src/agent/agent.ts` (or wherever the `╭── batch (N tools)` heading is rendered) — pick the heading based on the actual partition.
- New pure helpers + tests.

## Implementation order

1. **Pure helper `truncatePermissionLabelLine(line, boxWidth)`** — pure string truncate that respects the box's interior width (`boxWidth - 6` to account for `│  ` left + `│` right + padding). Returns the line capped with `…` when it would overflow.
2. **Apply the helper to each modal option line** in `permission-prompt.ts`, especially the `[A]` line which contains the full `tool` + `target`.
3. **Pure helper `classifyBatchDispatch(tools): "parallel" | "serial" | "mixed"`** — partition the tool list via `partitionToolCalls`; return:
   - `"parallel"` when serial.length === 0
   - `"serial"` when parallel.length === 0
   - `"mixed"` otherwise
4. **Update the heading render site** (find via grep `╭── batch \(`) to call the helper and render `╭── parallel (N tools)` / `╭── serial (N tools)` / `╭── mixed (P parallel + S serial)`.
5. **6 new tests** — 3 for the truncation helper (within budget / over budget / very narrow box) + 3 for the dispatch classifier (parallel-only / serial-only / mixed).

## Verification

- Unit: `truncatePermissionLabelLine("[A] allow always for this (run_command on node --check src/...)", 64)` returns a string ≤ box interior width with trailing `…`.
- Unit: `classifyBatchDispatch([write_file, write_file])` → `"parallel"`.
- Unit: `classifyBatchDispatch([run_command, run_command])` → `"serial"`.
- Unit: `classifyBatchDispatch([batch_read, run_command])` → `"mixed"`.
- Manual: trigger a permission prompt for a long `node --check src/very/long/path.js` command. Observe the `[A]` line truncates with `…` instead of running off the right edge.
- Manual: trigger a mixed batch (e.g. read + run_command). Observe `╭── mixed (1 parallel + 2 serial)` heading.

## Out of scope

- Larger permission-prompt visual redesign (e.g. richer affordances). Phase 12 deferred-Ink-port decision stands.
- Per-tool dispatch ordering hints inside the heading. The plan-display block below the heading already shows the per-tool list.

## Completion notes

- Implemented as planned. `classifyBatchDispatch` returns `BatchDispatchShape` (`"parallel" | "serial" | "mixed"`); `formatBatchHeading` returns `{ verb, detail }` so the agent.ts render site preserves the existing accent/muted colour split.
- Deviated slightly from step 1's helper name: shipped `truncateTargetForPermissionLabel(target, tool, boxWidth)` (target-level) rather than a line-level `truncatePermissionLabelLine`. Reason: the longest line varies by tool name; truncating just the dynamic target lets us reuse the same value throughout the modal without re-running the truncation per line. Same bug fixed; cleaner shape.
- `formatBatchHeading` empty-batch convention: returns `{ verb: "parallel", detail: "(0 tools)" }`. The render site already guards against empty batches, so this is purely defensive.
- Tests: 10 new unit tests (4 for `classifyBatchDispatch`, 4 for `formatBatchHeading`, 6 for `truncateTargetForPermissionLabel`). All 692 cli-client tests pass.
- One test-bug caught during execution: the "respects a wider box on a 120-col terminal" test originally expected the long `node --check …` target to fit verbatim at 80-col width, but the worst-case button-label overhead (`[A] allow always for this (run_command on )` ≈ 44 chars) leaves only ~35 budget. Reframed the assertion to "wider box yields a longer surviving string" — still verifies the budget-scaling behaviour without an arbitrary width threshold.
