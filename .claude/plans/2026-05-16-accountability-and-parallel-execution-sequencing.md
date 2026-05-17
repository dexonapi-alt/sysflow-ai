# Accountability + parallel-execution sequencing

- **Created:** 2026-05-16
- **Status:** draft
- **Scope:** Stop the agent from blasting 11 parallel tool calls without reasoning about each, from re-creating files it already wrote, from writing consumers before producers, and from declaring done without reading-back what it produced. Closes the user-reported pattern where the agent dispatched 11 tools in one batch (3 mkdirs + 8 writes), then wrote `src/index.ts` importing files that didn't yet exist (silently stripped by import-sanitizer), then claimed complete without verifying any of it.

## Goal

User report (2026-05-16):

> *"it doesn't have to be parallel all, it needs to reason every files he make and edit, and it should read it first. and if he accounted it all he can do the parallel"*
>
> *"it's not accounting what he did, like in the parallel execution it's just make the parallel files without asking why it should be that file"*
>
> *"it should read what he did"*
>
> *"our ai lacks accountability, reasoning use, memory, and it hallucinated so badly"*

The agent's current execution pattern:

1. Generates a big response with `tools: [...]` containing N parallel calls.
2. `cli-client/src/agent/executor.ts` calls `groupForParallelExecution(tools)` which packs as many parallel-safe writes into one batch as possible.
3. Executes the whole batch in `Promise.allSettled`.
4. Sends one combined `tool_result` to the server.
5. Server processes, agent emits the next response.

Problems with this:

- **No per-file reasoning.** The agent's `reasoningChain[]` has one paragraph for the WHOLE batch — *"Create the required folder structure and source files for middleware, utilities, and route handlers"* — not one per file.
- **No ordering reasoning.** A batch can include `src/index.ts` (which imports `./routes/auth`) alongside `src/routes/auth.ts` (the producer). If `index.ts` is processed by import-sanitizer BEFORE `auth.ts` is created, the import gets stripped. Net result: a broken index.ts.
- **No read-back.** Agent writes files; declares done; never verifies what landed actually matches what it intended.
- **No "did I create this already" check.** Across chunks, the agent re-creates files it already wrote (user-reported D1).

End state — for a fresh scaffold:

- Implement-class runs cap parallel batches at **3 tools per batch by default** (configurable). Larger batches require explicit per-file reasoning paragraphs in `reasoningChain[]`.
- **Producer-before-consumer ordering**: when a batch creates files that import each other, the executor topologically orders them (or rejects the batch back to the agent if cycles).
- **Mandatory read-after-write** for the FIRST batch of writes in a fresh scaffold: after the writes complete, the next prompt forces a read of every new file + a verify step.
- **"Already created" guard**: if the agent emits `write_file` for a path the working context tracks as `action: "created"` in this run, the cli warns the model.

## Context from knowledge base

- `architecture.md: ## Forced error reasoning + recovery` — INJECT pattern reused for the "you already created this" guard.
- `architecture.md: ## Project-init reasoning` — Stage 1 of this plan respects the repoState classification (relax caps on `existing-large` repos where the agent's edit batches may legitimately be wider).
- `decisions.md: ## System-level enforcement beats prompt-level guidance for free models` — load-bearing. Telling the model "please reason per file" doesn't work; mechanical batch caps + per-file rejection do.
- `decisions.md: ## Reasoning peek truncates by default; r toggles full view` — per-file reasoning paragraphs land here; need to coordinate with the Reasoning peek's truncation budget.
- `applied/2026-05-15-free-tier-quality-enforcement.md` — verify-after-write injector is the template for Stage 3's read-back.
- `applied/2026-05-15-agent-runtime-fixes-and-project-init-reasoning.md` Stage 4 — the directory-refresh + working-context file map this plan reads from for the "already created" guard.

## Affected files

### Stage 1 — Parallel batch cap on implement runs

- `cli-client/src/agent/executor.ts` — `groupForParallelExecution` (or wherever the cli builds the batch list). Add a cap:
  - Default: 3 tools per batch.
  - When `repoState === "empty" | "small"` (fresh scaffold), cap stays at 3.
  - When `repoState === "existing-large"`, cap relaxes to 5 (the agent's batch is more likely to be a wide edit across an existing codebase).
  - Caps are configurable via flags.
- When the agent emits N > cap tools in one response, the cli executes them as **multiple sequential batches of `cap` size**, sending separate `tool_result` payloads. Each `tool_result` triggers a new model call so the agent reasons between batches.
- 6 new tests: cap respected; cap relaxes by repoState; sequencing produces N/cap separate tool_result calls.

### Stage 2 — Producer-before-consumer ordering within a batch

- `cli-client/src/agent/executor.ts` — when a batch contains multiple `write_file` calls, parse each file's content for relative imports (cheap regex `/import .* from ['"](\.\/[^'"]+)['"]/g`). Build a dependency graph among the batch's files.
- Topologically sort writes so producers go before consumers within the batch (or before the batch if they're already on disk).
- If a cycle is detected → reject the batch back to the agent with a synthetic `validation_failure` listing the cycle + suggestion to break it.
- This avoids the import-sanitizer band-aid: by the time consumer files write, producers exist.
- 8 new tests: linear chain orders correctly; diamond dep works; cycle rejected; no relative imports = no reordering.

### Stage 3 — Mandatory read-after-write for the first scaffold batch

- `server/src/handlers/tool-result.ts` — after the FIRST batch of `write_file` calls on a fresh scaffold (repoState empty/small), inject a `═══ READ-AFTER-WRITE REQUIRED ═══` block into the next prompt:
  ```
  ═══ READ-AFTER-WRITE REQUIRED ═══

  You just authored N files in a fresh scaffold:
    - package.json
    - tsconfig.json
    - src/index.ts
    - src/config/db.ts

  Before proceeding to the next batch, READ each of these files back (use batch_read).
  Verify each file contains what you intended; the import-sanitizer or escaping may have
  altered your intent. If any file has wrong content, REWRITE it before continuing.

  Do NOT issue another write_file batch until you've completed this verification.

  ═══ END READ-AFTER-WRITE REQUIRED ═══
  ```
- The ack-validator (Stage 4 of forced-error-reasoning) catches the case where the agent ignores this and issues another write batch — rejects with reinforcement.
- 6 new tests: inject fires on first scaffold batch; doesn't fire on edits to existing files; ack-validator catches the ignore case.

### Stage 4 — "Already created in this run" guard

- `cli-client/src/agent/executor.ts` — before dispatching a `write_file` call, check if the working-context (Stage 4 of agent-runtime-fixes plan; per-run file map server-side) tracks the path as `action: "created"` AND `verified: true`.
- If yes → instead of writing blindly, synthesise a synthetic warning result + skip the actual write:
  ```
  {
    "tool": "write_file",
    "result": {
      "error": "You already wrote this file at tick N. The earlier content is on disk; re-writing will overwrite it. If you intended to UPDATE the file, use edit_file instead. If you intended to verify the prior write, use read_file. If you really meant to overwrite, retry with `_acknowledge_overwrite: true`.",
      "_errorCategory": "already_created",
      "success": false
    }
  }
  ```
- Server's existing error path (forced-error-reasoning Stage 3) picks this up, inject block fires, agent has to acknowledge before retrying.
- The agent can pass `_acknowledge_overwrite: true` in the args to bypass the guard explicitly.
- 6 new tests: first write succeeds; re-write blocked; edit_file unaffected; explicit acknowledge bypasses.

### Stage 5 — Per-file reasoning required for batches > N

- `server/src/handlers/tool-result.ts` (or normalise-side) — when the agent's response has `tools[]` with length > 3 AND `reasoningChain[]` has fewer paragraphs than `tools.length`, reject the response via the existing Stage 4 ack-rejection loop with:
  ```
  ═══ INSUFFICIENT REASONING FOR BATCH ═══

  You emitted N tool calls in one batch but only K paragraphs in reasoningChain[].

  Required: one paragraph in reasoningChain per file/tool justifying why THIS file
  matters and how it fits the build plan. Without this, your peers (and the user
  watching the reasoning peek) can't follow your decisions.

  Either:
   1. Reduce the batch size to ≤ 3 tools, OR
   2. Add reasoning paragraphs (one per tool) and resubmit.

  ═══ END INSUFFICIENT REASONING ═══
  ```
- 6 new tests: short batches pass; large batches with enough paragraphs pass; large batches without are rejected.

### Stage 6 — Telemetry + KB + plan archive

- `cli-client/src/agent/usage-log.ts` — `RunSummary` gains:
  - `maxBatchSize: number` (largest batch size observed this run)
  - `reorderedBatchCount: number` (per-run count of batches where Stage 2 topological sort moved items)
  - `alreadyCreatedRejectionCount: number` (Stage 4 hits)
  - `insufficientReasoningRejectionCount: number` (Stage 5 hits)
- KB:
  - `architecture.md: ## Batch sequencing + accountability` — diagram of cap + topo-sort + read-back + already-created composition.
  - `decisions.md: ## Parallel batches cap at 3 tools by default on implement runs` — rationale (per-file reasoning visibility; per-file model agency).
  - `decisions.md: ## Producer-before-consumer ordering inside batches` — rationale + alternatives rejected (relying on import-sanitizer / asking model to self-order).
  - `gotchas.md: ## Agent wrote 11 tools in parallel and produced broken imports` — canonical repro.
- Plan archived to `applied/`.

## Migrations / data

None.

## Hooks / skills / settings to update

- `quality.parallel_batch_cap_default` (number, default `3`)
- `quality.parallel_batch_cap_existing_large` (number, default `5`)
- `quality.parallel_batch_topo_sort_enabled` (bool, default `true`)
- `quality.read_after_write_on_fresh_scaffold` (bool, default `true`)
- `quality.already_created_guard_enabled` (bool, default `true`)
- `quality.per_file_reasoning_required_enabled` (bool, default `true`)
- `quality.per_file_reasoning_threshold` (number, default `3`)

## Dependencies

- No new packages. Stage 2's regex-based import detection is pure string match (sufficient for the common case; misses obscure dynamic imports but those don't trigger ordering issues).

## Risks & mitigations

- **Cap of 3 tools per batch slows down legitimately wide scaffolds.** Mitigation: a fresh Express scaffold has ~5-8 core files (package, tsconfig, index, routes, middleware, db). At cap 3 that's 2-3 batches with reasoning between. Latency cost: ~2-3 extra model calls per scaffold. Worth it for visibility + accountability.
- **Topological sort with cyclic imports fails.** Mitigation: reject the batch with a cycle-explanation to the agent. The agent has to break the cycle by splitting one of the imports out.
- **Already-created guard fires on legitimate re-writes (e.g. agent fixing a typo).** Mitigation: the `_acknowledge_overwrite: true` escape hatch makes intent explicit. Telemetry on `alreadyCreatedRejectionCount` shows if the guard over-fires.
- **Per-file reasoning quota inflates response size / cost.** Mitigation: only fires above batch size 3 (well-justified larger batches still allowed). Smaller batches don't need per-file reasoning.
- **Read-after-write inject burns tokens on trivial files.** Mitigation: only fires on the FIRST scaffold batch of a fresh repo. After that, the chunked-reasoning loop's reflector covers verification.

## Implementation order

1. **Stage 1 — Parallel batch cap.** Mechanical; biggest single-impact change. *(One PR.)*
2. **Stage 4 — Already-created guard.** Independent of others; closes the cross-chunk re-creation bug. *(One PR.)*
3. **Stage 2 — Topological ordering.** Builds on Stage 1's batching but isolated. *(One PR.)*
4. **Stage 3 — Read-after-write inject.** Builds on Stage 1's "first scaffold batch" detection. *(One PR.)*
5. **Stage 5 — Per-file reasoning gate.** Builds on the reasoning-chain provider parity plan (so per-file paragraphs actually reach the peek). *(One PR.)*
6. **Stage 6 — Telemetry + KB + plan archive.** *(One PR.)*

Each stage = one PR off `main`. ~1,400 LOC + 32-36 new tests across six stages.

## Verification

**Stage 1**

- Unit: 8-tool response → 3 batches of 3 + 1 of 2; each sends a separate tool_result; repoState relaxes cap.
- Manual: agent emits a wide scaffold; observe ≤ 3-tool batches in cli output with reasoning between.

**Stage 2**

- Unit: linear chain → reordered; diamond → ordered; cycle → rejected.
- Manual: agent writes index.ts importing routes/auth in the same batch; observe routes/auth lands first.

**Stage 3**

- Unit: first scaffold batch fires inject; subsequent edits don't; ack-loop catches ignore.
- Manual: scaffold; observe READ-AFTER-WRITE block in next prompt; agent reads back.

**Stage 4**

- Unit: re-write blocked; edit_file unaffected; explicit acknowledge bypasses.
- Manual: force agent to re-issue a write — observe rejection + acknowledge path.

**Stage 5**

- Unit: short batches pass; large with enough paragraphs pass; large without rejected.

**Stage 6**

- Telemetry populates. KB entries lint clean.

## Out of scope

- **Sub-file granularity** (per-export or per-function reasoning). Too invasive.
- **Cross-run accountability** (the agent should remember it wrote X in a prior run / chat). Phase 8 memory already handles cross-session continuity for files modified; this plan focuses on within-run accountability.
- **Topological sort across npm package imports.** Stage 2 only handles relative imports inside the batch's files.
- **Automatically generating per-file reasoning if the agent forgets.** No — the rejection forces the model to do it. Auto-generating would be the wrong agency split.

## Composition with existing systems

- **Reasoning-chain provider parity plan** — provides the per-file reasoning paragraphs surface so Stage 5's per-file requirement is actually visible to the user.
- **Code-correctness plan** — Stage 3 of that plan's tsc gate fires after Stage 5's per-file reasoning is in place; the combination is "you wrote N files reasoning each one + tsc verified them clean".
- **Awareness plan** (sibling) — `intent_keyword_absent` improvement reduces false off-course flags during wide scaffolds.
