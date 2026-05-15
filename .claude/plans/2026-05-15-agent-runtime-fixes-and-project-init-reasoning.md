# Agent runtime fixes + project-initialisation reasoning

- **Created:** 2026-05-15
- **Status:** in-progress
- **Scope:** Fix seven concrete runtime bugs surfaced by a fresh `sys` run in an empty directory + introduce a **project-initialisation reasoning step** that works correctly in both empty repos and large existing repos. The agent's current behaviour (hallucinate config dependencies → force web search → die on 0 hits → never recover) makes it unusable on greenfield prompts. The fixes compose: an explicit repo-state classifier removes the phantom-dependency hallucination at the source, web-search gating removes the wrong-tool-too-early failure, and the reasoning-peek expand toggle gives the user visibility into deliberation that today is silently truncated.

## Goal

The user reported the following from a single fresh run in `C:\Users\DevAPI\Documents\test` with prompt *"build a Node.js Express PostgreSQL backend for a simple POS system"*:

> ```
> ● List(.)
> │ Need to verify current typescript configuration before writing files — framework APIs change frequently.
> ▸ search web "tsconfig.json configuration 2026"
> ● WebSearch(tsconfig.json configuration 2026)
> ─ 0 hits
> │ No tsconfig.json configuration data was found in the search results. Please provide the desired configuration details or a source link.
> ```

In an empty directory, with no mention of TypeScript in the prompt, the agent (a) demanded a tsconfig that doesn't exist, (b) used web search for the answer, (c) gave up when search returned nothing. The user's seven bugs all reduce to three composable failure modes:

1. **No repo-state awareness** (bugs 1, 2, 5) — the agent has no concept that the directory is empty, so it can't tailor behaviour between "scaffold from scratch" and "modify existing project".
2. **Wrong tool, too early, with no recovery** (bugs 3, 4) — web search runs before investigation commands, and 0-hit results dead-end instead of pivoting.
3. **UI hides the deliberation that would let the user diagnose 1 + 2** (bugs 6, 7) — reasoning peek truncates without an expand affordance, so the user can't see why the agent went off course.

End state — for the SAME prompt in the SAME empty directory:

```
● List(.)
│ Empty directory. Classifying as fresh scaffold.
│ Stack inference (from prompt): Node.js + Express + PostgreSQL backend, POS domain.
│ Plan: scaffold package.json → install deps → write Express server → wire pg client → write migration.
│ No external config to verify (fresh dir); using best-practice defaults.
▸ run_command "npm init -y"
● run_command(npm init -y) ✓
…
```

And for the SAME prompt in a directory with 200 existing files:

```
● List(.)
│ Existing project detected: package.json present, src/ with 87 files. Classifying as existing-large.
│ Reading package.json + scanning src/ before changes.
▸ run_command "cat package.json"
▸ search_files "src/**/*.{ts,js}"
…
```

## Context from knowledge base

- `architecture.md: ## Awareness loop (Phase 11)` — divergence detector + verification gate fire AFTER chunks complete. This plan adds a pre-chunk repo-state classifier so the agent doesn't start a chunk in the wrong direction.
- `architecture.md: ## Forced error reasoning + recovery` — the four-net pattern (chain → inject → reject → memory) is the template. Bug 4 (0-hit web search no recovery) reuses the same shape: classify the failure, surface a hint, force re-routing.
- `architecture.md: ## LLM-driven intent classification` — the iterative paragraph chain pattern is reused here for project-init reasoning. One more concrete use case after preflight + intent + error reasoning.
- `decisions.md: ## System-level enforcement beats prompt-level guidance for free models` — load-bearing for the action-planner gating in Stage 1. Telling the agent "investigate first" in the prompt doesn't work when action-planner can override it; we have to mechanically prevent the override on fresh scaffolds.
- `decisions.md: ## Error reasoning is an iterative chain, not a single-shot LLM call` — same rationale applies to project-init reasoning. Repo state is ambiguous when the directory has 12 files (could be a one-off script repo or a stub of a new project); iterative chain lets the LLM commit when it's sure and ask a follow-up question when it's not.
- `decisions.md: ## INJECT + REJECT pairs replace prompt-level "please reason about errors"` — bug 4's fix uses the same shape: inject a "0-hit hint" + reject responses that retry the same search verbatim.
- `gotchas.md: ## Reasoning cache key was prefix-truncated → chunk plans aliased` — informs the project-init brief's caching: hash the full repo signature (file list + sizes), not a prefix.
- `applied/2026-05-13-command-first-investigation.md` — Stage 1's "FIRST turn MUST be run_command" rule is what action-planner's web-search hijack violates. This plan's Stage 1 closes that loop.
- `applied/2026-05-15-free-tier-quality-enforcement.md` — Stage 1's verify-after-write INJECT pattern is the template for Stage 2's web-search-empty inject.
- `applied/2026-05-15-forced-error-reasoning-and-recovery.md` — the just-shipped error-reasoning plan establishes the iterative chain + inject + reject + memory pattern this plan extends.

## Affected files

### Stage 1 — Project-init reasoning + action-planner gating (cures bugs 1, 2, 5)

- `server/src/reasoning/pipelines/project-init-pipeline.ts` (NEW) — system prompt for the project-initialisation reasoner. Senior-engineer rubric:
  1. **Snapshot** — what files are in the directory? Count + key markers (`package.json`, `pyproject.toml`, `Cargo.toml`, `.git/`, `node_modules/`, source folders).
  2. **Classify** — `empty` (0-1 files) / `small` (2-15 files, no `node_modules`) / `existing-small` (has package manifest, < 50 source files) / `existing-large` (≥ 50 source files OR multiple workspaces).
  3. **Infer intent** — does the user's prompt match the existing project's shape? Greenfield prompt in existing-large = caution; scaffolding prompt in empty = expected.
  4. **Investigation plan** — 2-5 concrete commands to run FIRST. Empty: `npm init -y` then write package.json. Existing-large: read package.json + relevant config files + grep for the feature area.
  5. **Constraints** — what files should NOT trigger config-verification on this run? (For empty repo: any greenfield-authored config like tsconfig.json / .eslintrc / .prettierrc — those are AUTHORED here, not verified against the web.)
  6. **Decide** — `done: true` with `repoState`, `investigationPlan[]`, `skipConfigVerificationFor[]`, OR `done: false` with the specific follow-up.
- `server/src/reasoning/pipelines/index.ts` — register `project_init` as a `PipelineKind`.
- `server/src/reasoning/project-init-reasoner.ts` (NEW) — orchestrator `runProjectInitChain(payload, callBackend?)`. Mirrors `runErrorReasoningChain`. Max 3 iterations cap (repo state is less ambiguous than error class). Schema:
  ```ts
  {
    kind: "project_init",
    paragraphs: string[],
    repoState: "empty" | "small" | "existing-small" | "existing-large",
    fileCount: number,
    keyMarkers: string[],                  // ["package.json", "src/", ".git/"]
    investigationPlan: string[],           // concrete commands: ["cat package.json", "ls src/"]
    skipConfigVerificationFor: string[],   // ["tsconfig.json", ".eslintrc.json"]
    confidence: "HIGH" | "MEDIUM" | "LOW"
  }
  ```
- `server/src/handlers/user-message.ts` — fire `runProjectInitChain` BEFORE the existing preflight reasoner when the run is implement-class. Brief threads onto the provider payload (`providerPayload.projectInitBrief`).
- `server/src/services/setup-intelligence.ts` — `detectConfigFile()` gains a `skipForRun: string[]` parameter. Returns null when the path matches an entry in the run's `skipConfigVerificationFor` list.
- `server/src/services/action-planner.ts` — `buildConfigSearchOverride()` consults the run's `projectInitBrief.skipConfigVerificationFor` (read from per-run state). If the file is on the skip list, NO web-search override fires.
- `server/src/services/context-manager.ts` — `ingestDirectoryTree()` writes a structured snapshot to the working context AND surfaces it as a `directory_snapshot` fact that downstream prompt sections can read.
- `server/src/providers/prompt/sections/directory.ts` (existing or NEW) — renders a `═══ PROJECT STATE ═══` block in the system prompt with: `repoState`, file count, key markers, and the investigation plan as a numbered list. Lives BEFORE the existing tool reference so it sets up the agent's first move.
- New flag `quality.project_init_reasoning_enabled` (default `true`).
- 18-22 new tests across the orchestrator, schema, action-planner skip logic, and prompt rendering.

### Stage 2 — Web search gating + 0-hit recovery (cures bugs 3, 4)

- `server/src/providers/prompt/sections/tools.ts` — `web_search` tool description gains a precondition line: *"Only after at least one investigation command (run_command / list_directory / read_file) AND a clear signal you need external documentation. NEVER as the first tool in a run. NEVER for default config files you are AUTHORING."*
- `server/src/services/tool-error-classifier.ts` — new category `web_search_empty`. `classifyToolErrorFromResult` recognises a web_search result with `results: []` (or no `results` array on a successful response) and returns:
  ```
  ⚠️ WEB SEARCH RETURNED 0 HITS: Your query found no current documentation. This usually means:
    1. The query is too specific (e.g. "tsconfig.json configuration 2026" — no such guide exists at that specificity)
    2. The information is well-known and doesn't need verification (use best-practice defaults)
    3. The framework/library name was misspelled
  Do NOT retry the same query. Either reformulate with a broader scope, or skip the search entirely and proceed with the best-practice default.
  ```
- `cli-client/src/agent/executor.ts` — when `web_search` returns 0 hits, the result envelope includes `_errorCategory: "web_search_empty"` so the server-side classifier short-circuits to the new hint.
- `server/src/handlers/tool-result.ts` — when the validator sees a `web_search_empty` result AND the agent's next response either retries the same search OR halts with "no information found", trigger the Stage 4 error-acknowledgement reject loop pointing at the recovery hint. Reuses `validateErrorAcknowledgement` with a synthesised error context.
- 10-14 new tests covering the classifier category, the 0-hit envelope, and the reject hook.

### Stage 3 — Reasoning peek expand toggle (cures bugs 6, 7)

- `cli-client/src/ui/components/ReasoningPeek.tsx` — wire `useInput` to listen for `r` (and `Ctrl+R` as alias). `expanded: boolean` state toggles between truncated (current behaviour: 3 paragraph lines, 180 char per line) and full (all paragraphs, no per-line cap).
- Render a hint line below the peek: *"press `r` to expand reasoning · press `r` again to collapse"*. Hint only shows when there ARE truncated paragraphs OR truncated lines (no hint when everything fits).
- `cli-client/src/ui/hooks/useAgentEvents.ts` — `reasoning_brief` event reducer slot adds a `version` counter so successive emissions for the SAME run re-key the peek (forces remount → resets `expanded` to false for new context).
- `cli-client/src/agent/agent.ts` — per-turn `reasoningChain` from each response gets emitted as its OWN `reasoning_brief` event with `kind: "per_turn"`. Today only preflight / error-reasoning / intent-classification briefs surface; the per-turn paragraphs that drive each individual tool decision are visible inline but never replace the peek. Stage 3 surfaces them so the peek tracks the LATEST reasoning, not the FIRST.
- 6-8 new tests in `ReasoningPeek.test.tsx` for the expand toggle + per-turn event handling + version bump.

### Stage 4 — Per-turn directory tree refresh (cures bug 5)

- `cli-client/src/agent/executor.ts` — after every tool execution that writes / deletes files, refresh the directory tree snapshot and include it in the next `tool_result` payload.
- `server/src/services/context-manager.ts` — `ingestDirectoryTree()` compares the new snapshot against the working context's `files` map. Files present in the old map but absent in the new snapshot get marked `status: "deleted"` (or pruned outright when older than 1 turn). Surfaces as `staleFileCount` in the working context summary.
- `server/src/handlers/tool-result.ts` — when `staleFileCount > 0`, inject a one-shot reminder block: *"⚠ N files referenced earlier no longer exist on disk. Use the updated PROJECT STATE block; do NOT reference deleted files."*
- 6-8 new tests for the refresh + stale-file detection + injection.

### Stage 5 — Telemetry + KB + plan archive

- `cli-client/src/agent/usage-log.ts` — `RunSummary` gains:
  - `projectInitRepoState: "empty" | "small" | "existing-small" | "existing-large" | null`
  - `projectInitConfidence: "HIGH" | "MEDIUM" | "LOW" | null`
  - `webSearchEmptyCount: number` (per-run count of 0-hit web searches; spikes mean Stage 2 isn't gating tightly enough)
  - `reasoningPeekExpansions: number` (per-run count of user pressing `r` to expand; informs whether the truncation cap is set too tight)
- `server/src/types.ts: ClientResponse` — gain `projectInitBrief` surface (chain paragraphs for `<ReasoningPeek>`) + `projectInitRepoState` (constant for run).
- KB:
  - `architecture.md: ## Project-init reasoning` — diagram of the new pre-preflight step + classification table.
  - `decisions.md: ## Why a separate project-init pipeline instead of folding into preflight` — preflight is implement/bug/decision-scoped; repo state is a different concern that BOTH preflight and the main model need.
  - `decisions.md: ## 0-hit web search is a recovery situation, not a success` — alternatives rejected (silent 0 hits, retry-with-fallback-query, suppress web_search entirely).
  - `gotchas.md: ## Agent demanded tsconfig.json in empty directory and hard-stopped on 0-hit web search` — the canonical trigger for this plan; preserves the repro for future contributors.
- Plan archived to `applied/`.

## Migrations / data

`project_init` is a new pipeline kind — additive to the existing registry. No schema changes for memory entries (the repo-state classification is per-run state, not persisted). No migration.

## Hooks / skills / settings to update

- New flags:
  - `quality.project_init_reasoning_enabled` (bool, default `true`) — Stage 1 kill switch.
  - `reasoning.project_init_max_iterations` (number, default `3`) — chain depth cap.
  - `quality.web_search_first_action_block_enabled` (bool, default `true`) — Stage 2 first-action-can't-be-web-search hard gate.
  - `quality.web_search_empty_recovery_enabled` (bool, default `true`) — Stage 2 0-hit reject loop kill switch.
  - `ui.reasoning_peek_expand_key` (string, default `"r"`) — Stage 3 expand-key override for users on terminals that capture `r`.
- No `.claude/hooks/` changes. No skill changes.

## Dependencies

- No new npm packages.
- Reuses `pickReasonerBackend` for the project-init reasoner.
- Reuses the iterative paragraph chain pattern from `error-reasoner.ts` (PR #88) — orchestrator is structurally near-identical.
- Reuses `validateErrorAcknowledgement` + reject builder for the web-search-empty recovery loop.

## Risks & mitigations

- **Project-init reasoning adds latency on EVERY implement-class run.** Mitigation: cache the brief by `sha256(sortedFileList + sizes)` for the run; same repo state → same brief (no re-fire). Free-tier overhead: ~1 extra Flash call per FRESH run, 0 on cache hits.
- **The classifier mis-categorises (empty repo classified as small because `.git/` + `README.md` present).** Mitigation: confidence-aware downstream consumption. HIGH-confidence repoState drives action-planner skip; MEDIUM/LOW falls back to today's behaviour (action-planner still allowed to hijack). Phase 15's contradiction loop catches recall mistakes.
- **Action-planner's config-verification served a real purpose (preventing stale config writes in EXISTING projects).** Mitigation: skip applies ONLY when the project-init brief listed the file in `skipConfigVerificationFor`. Empty repo → list contains `tsconfig.json` etc.; large existing repo → list is empty; the override still fires. Default fail-safe is the existing override path.
- **0-hit web search recovery loop livelocks on a model that keeps re-searching.** Mitigation: cap at 2 retries (lower than the 3-rejection cap for Stage 4 of forced-error-reasoning — web search is recoverable in fewer pivots than a tool error). After cap, the system gives up and Phase 11 awareness's `repeated_tool_error` heuristic takes over.
- **`r` is a common terminal-emulator binding.** Mitigation: keyboard hint advertises the binding explicitly; `ui.reasoning_peek_expand_key` flag lets users override; Ink `useInput` only fires when the input box doesn't have focus. Aliased to `Ctrl+R` to honour the user's specific request.
- **Per-turn directory refresh adds I/O on every tool call.** Mitigation: refresh ONLY after tools that write / delete (`write_file`, `edit_file`, `batch_write`, `create_directory`, `run_command` with rm / mv). Read-only tools skip the refresh. Cached `mtime` short-circuits when nothing changed.
- **Big repos make the directory snapshot expensive.** Mitigation: cap at 500 entries with depth-2 by default (matches `directoryTree` already shipped). Existing limit; project-init reasoner sees the same capped view the agent does, so there's no "the brief knew more than the agent" risk.
- **Reasoning peek refresh on EVERY `reasoning_brief` event flickers the UI.** Mitigation: the existing `prevKey + 1` shape already serialises updates; the version counter just makes re-keying explicit. No render-frequency change.

## Implementation order

1. **Stage 1 — Project-init reasoning + action-planner gating.** Foundation: new pipeline + schema + orchestrator + tests + the action-planner skip path. Largest blast radius (touches the implement run's first turn). *(One PR.)*
2. **Stage 2 — Web search gating + 0-hit recovery.** Adds the precondition to the prompt + new tool-error category + reject hook. Reuses Stage 4 of forced-error-reasoning's validator. *(One PR.)*
3. **Stage 3 — Reasoning peek expand toggle.** Pure cli change. Adds `useInput` + expanded state + per-turn `reasoning_brief` emission. *(One PR.)*
4. **Stage 4 — Per-turn directory tree refresh.** Cli executor + server context-manager + injection. *(One PR.)*
5. **Stage 5 — Telemetry + KB + plan archive.** Four new RunSummary fields + KB entries + plan flip. *(One PR.)*

Each stage = one PR off `main`. Stage labels: `feat(reasoning): project-init reasoning + action-planner gating`, `feat(tools): web search gating + 0-hit recovery`, `feat(cli): reasoning-peek expand toggle`, `feat(runtime): per-turn directory refresh`, `feat(reasoning): Stage 5 — telemetry + KB + plan archive`.

## Verification

**Stage 1**

- Unit: `parseProjectInitStep` parses well-formed iterations; rejects malformed; `done: true | false` both work.
- Unit: orchestrator commits with full `repoState` brief; runs to cap on cold LLM; falls back gracefully.
- Unit: `detectConfigFile()` returns `null` when path matches the skip list; otherwise behaves as today.
- Unit: `buildConfigSearchOverride()` reads the per-run `skipConfigVerificationFor` and returns no override for skipped files.
- Manual: run `sys "build me an Express PG backend"` in an empty dir → observe project-init brief commits as `repoState: "empty"`, no tsconfig.json web-search hijack, agent runs `npm init -y` as the first tool.
- Manual: same prompt in an existing TS project → observe `repoState: "existing-large"`, agent reads `package.json` + relevant src files before changes.

**Stage 2**

- Unit: `classifyToolErrorFromResult` returns `web_search_empty` for `{ results: [] }`.
- Unit: the reject hook fires on retry-same-query but not on broader-pivot.
- Manual: trigger a 0-hit web search → observe the recovery hint in the next tool-result body + the agent pivots to defaults rather than halting.

**Stage 3**

- Unit: `ReasoningPeek` re-keys on `reasoning_brief` event version bump.
- Unit: `useInput` handler toggles `expanded` on `r` keypress.
- Manual: long reasoning brief → press `r` → see all paragraphs. Press `r` again → see truncated view.
- Manual: per-turn reasoning paragraphs surface in the peek as the agent iterates (not stuck on the first brief).

**Stage 4**

- Unit: `ingestDirectoryTree` marks stale files when the new snapshot is smaller than the old.
- Unit: the staleness injection block fires only when `staleFileCount > 0`.
- Manual: delete a file mid-run via run_command → observe the next turn's tool-result body warns "⚠ N files no longer exist".

**Stage 5**

- Telemetry: `projectInitRepoState` + `projectInitConfidence` + `webSearchEmptyCount` + `reasoningPeekExpansions` populate per-run in `usage.jsonl`.
- All KB entries lint cleanly.
- `npm test` + `npm run typecheck` green across both workspaces.

## Out of scope

- **Auto-executing the project-init brief's investigation commands** without the model's agreement. Same principle as forced-error-reasoning: the brief recommends; the model commits. Removing model agency on the first turn would be a wrong reversal of the command-first-investigation principle (the model decides what to investigate, the brief just gives a starting menu).
- **Fixing web search reliability.** The user noted *"web search is currently unreliable and broken"*. That's an upstream provider issue (the search API itself). This plan addresses how the agent BEHAVES with an unreliable web search; making search reliable is a separate plan (probably a different provider or a local cache).
- **Cross-run project-init memory.** The repo state is computed fresh each run because the directory can change between runs. Caching across runs would invite stale snapshots. Within a single run the brief IS cached (sha256 of file list).
- **Refactoring action-planner's broader override mechanism.** It serves multiple purposes (config verification, broken-tool recovery, loop detection). Stage 1 only adds a skip path for project-init briefs; the rest stays.
- **Expanding the project-init classification to languages beyond JS/TS/Python/Rust.** Markers are tuned to the four most common stacks in observed runs. Adding Go / Java / .NET markers is a one-line change but not necessary for the failure mode this plan fixes.

## Composition with existing systems

- **Phase 11 awareness** still fires `repeated_tool_error` and `same_action_repeated_in_session`. Stage 2's web-search-empty reject loop catches the FIRST 0-hit instance; Phase 11 catches sustained repetition past the cap. Both feed the same confidence tracker.
- **Forced-error-reasoning plan** (just shipped) is the template for Stage 2's recovery shape. Same chain → inject → reject pattern; new pipeline kind.
- **Command-first-investigation** (PR #66-#70 + #79) established the "first turn MUST be run_command" rule. Stage 1's action-planner gating is the mechanical enforcement layer that was missing — the prompt said it; action-planner could violate it; now it can't on fresh scaffolds.
- **Iterative paragraph chain** (PR #84-#86, #88) — `runProjectInitChain` is the fourth concrete use case. The pattern is canonical for *"think before you act"* across preflight, intent, error, and now repo-state.
- **Phase 8 persistent memory** — project-init brief is intentionally per-run-only (not persisted to `.sysflow-memory.md`). Repo state is volatile; memory entries should be invariants.

## Notes for implementation

The user's exact framing:

> *"agent should always check and track the file tree and always read and save awareness so it doesn't forgot and hallucinate."*
>
> *"make sure add the project initialization reasoning that will work in empty repo directory and big repo directory"*

The "save awareness" part is what Phase 8 memory + Phase 11 awareness already do for OPERATIONAL state. What's missing is the SHAPE-of-repo awareness at the START of each run. That's exactly what Stage 1 adds: a classifier output that's threaded into the system prompt's `═══ PROJECT STATE ═══` block + the action-planner's gating logic. Empty dir gets one shape; big repo gets another; the same prompt yields different first actions.

The systemic principle (per `decisions.md: ## System-level enforcement beats prompt-level guidance for free models`) drives every stage:

- Bug 1 — system enforces what the prompt couldn't: action-planner skip path stops the override on fresh scaffolds.
- Bug 3 — prompt-level gating + tool description preconditions (the agent reads `web_search` requires investigation FIRST).
- Bug 4 — system-level enforcement via the reject loop when the agent ignores the recovery hint.
- Bugs 6, 7 — UI-level enforcement: the user can't see what the agent is thinking past the truncation cap; expand-key fixes that.

Five stages, one PR each, ordered by blast radius (smallest first). Estimated total: ~2,800 LOC + 60-80 new tests. Estimated calendar: stages can ship sequentially over 5 days.
