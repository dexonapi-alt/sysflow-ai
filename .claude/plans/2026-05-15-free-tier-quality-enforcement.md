# Free-tier quality enforcement — verify-after-write, persistent task ledger, mandatory self-review

- **Created:** 2026-05-15
- **Status:** in-progress
- **Scope:** Five subsystems that enforce constant verification, investigation, and reasoning at the SYSTEM LEVEL (not prompt level) so free models can't drift, forget, or skip checks between iterations. Builds on Phase 11 awareness + Phase 16 free-tier policy + the command-first-investigation Stages 1-4 already merged; closes the failure modes those plans surface but don't fully prevent.

## Goal

User-reported failure modes specific to free models (Gemini Flash, OpenRouter free, LLaMA / Mistral via OpenRouter):

> *"the free models often create errors, typos, forgot to implement in X folder (no files implemented), AI Agent LITERALLY FORGOT WHAT TO DO, wrong implementations because it lacks checking every iteration, investigations every iteration, and reasoning on what it did and proceeding."*

> *"we need the reasoning to handle it and the reasoning should also check the checking, investigations, whys every iteration of the agent not just by prompt but every step chunks."*

The user's load-bearing insight: **prompts get ignored when models are confused or overloaded.** Adding more text to the system prompt won't fix it — the system has to enforce the behaviour itself by INJECTING reminders, REJECTING unverified completions, and FORCING the agent to pause and reason at specific moments.

Today's existing free-tier mitigations:
- Phase 11 awareness — divergence detector + LLM divergence + verification gate + off-course modal, with `FREE_MODEL_SENSITIVITY_BUMP = 10` raising thresholds for free models
- Phase 16 — `free-tier-policy.ts` central module, chained `implement_elaborate`, tightened chunk caps (8 chunks / 4 files vs 12 / 5)
- Phase 10 — chunk_reflect LLM verifies coherence after each chunk
- PR #70 — `no_investigation_before_write` heuristic catches "wrote files with no investigation"

The gap those don't close:
- **Verification is passive** — Phase 11's gates run on disk state and emit signals, but nothing INJECTS verification commands into the agent's next prompt to force the model to read back what it wrote
- **No persistent task ledger** — chunk plan has FILES for the next 1-5 writes, but no high-level "what subtasks remain" anchor. Agent forgets what it was doing after 5+ chunks
- **chunk_reflect is opportunistic** — it emits a verdict but doesn't FORCE the agent to read back files before continuing. Model can ignore the reflector's note
- **Per-chunk only** — divergence + verification fire at chunk boundaries. Free models drift WITHIN a chunk (3-4 turns); by the time the boundary fires, the bad implementation is done
- **No reasoning-vs-action cross-check** — the per-turn `reasoningChain` (PR #66) says "I'm about to verify the import resolves", then the agent writes a new file instead. Nothing catches this.

After this plan: free-tier runs have five overlapping nets — each catches a different failure mode the others miss.

## Context from knowledge base

- `gotchas.md: ## Free models commit to a wrong direction at chunk 1 and ride it to the end` — the canonical free-tier symptom. Phase 11 catches macro drift at chunk boundaries; this plan catches drift WITHIN a chunk + injects forced corrections.
- `gotchas.md: ## Same-file edits raced when batched` — sysflow already has experience injecting protections into the executor; this plan uses similar injection patterns for verification reminders.
- `architecture.md: ## Awareness + recovery (Phase 11)` — confidence tracker + divergence signals. This plan adds two new categories (`unverified_writes`, `reasoning_action_mismatch`) and extends the off-course modal with a "force re-review" option.
- `decisions.md: ## Free-tier policy is a centralised module` — `free-tier-policy.ts` is the natural home for the new "multiplier" helpers (`shouldForceVerifyAfterWrite`, `selfReviewCadence`, etc.).
- `applied/2026-05-07-phase-16-deep-reasoning-on-free-models.md` — chained Flash + tightened caps. This plan extends the same pattern: more checks for free models, lighter for paid.
- Composes on top of `2026-05-13-command-first-investigation.md` (Stages 1-4 merged at the time of this plan). This plan re-uses Stage 3's `investigationPlan` field and Stage 4's `no_investigation_before_write` heuristic as foundations.

## Affected files

**Stage 1 — Verify-after-write injector**

The agent should be FORCED to verify writes before proceeding. After every chunk that writes ≥1 file, the next tool-result message gets a synthetic `═══ VERIFY THE LAST CHUNK ═══` block instructing the agent to run concrete read-only commands BEFORE its next action. Free-tier: always on. Paid: complexity ≥ medium AND chunk wrote ≥ 3 files.

- `server/src/services/post-write-verifier.ts` (NEW) — pure helper `buildVerifyAfterWriteBlock(filesWritten, platform): string`. Generates 2-4 concrete commands based on what was written:
  - `cat <file>` for each new file (read back what we wrote)
  - `npm run typecheck` if any `.ts`/`.tsx` file was written (must succeed)
  - `npm run lint` if there's a lint script
  - `find <new-dir> -type f` for any new directory (catches the empty-folder failure mode at the source)
  - Platform-aware: PowerShell forms on Windows (`Get-Content`, `Get-ChildItem -Recurse`)
- `server/src/handlers/tool-result.ts` — at the end of each chunk that wrote files, append `buildVerifyAfterWriteBlock(...)` to the next tool-result message body so the agent sees it before deciding the next action.
- `server/src/services/free-tier-policy.ts` — new `shouldForceVerifyAfterWrite({ model, complexity, filesWrittenInChunk }): boolean`. True for free-tier always; paid only when complexity ≥ medium AND files ≥ 3.
- `server/src/services/flags.ts` — register `quality.force_verify_after_write` (bool, default `true`).
- Test: `post-write-verifier.test.ts` — generates correct commands for TS / JS / CSS / Python projects; platform-aware; respects empty-files-list edge case.

**Stage 2 — Persistent task ledger**

A high-level "what subtasks remain" anchor visible in the system prompt EVERY turn so the agent can't forget mid-run. Differs from the existing chunk plan (which is files for the NEXT chunk) and the existing taskPlan (which appears only when the AI emits one).

- `server/src/services/task-ledger.ts` (NEW) — per-run ledger of high-level subtasks. Shape: `{ id, label, status: "pending" | "in_progress" | "done", evidence?: string[] }`. Stored in-memory per runId (clears on run finalize).
- Population: preflight `implement` brief's `buildPlan` seeds the ledger (one ledger item per `buildPlan.step`).
- Updates: after each chunk_reflect, the LLM emits a `ledgerUpdates` field on the brief — `[{ id, status, evidence?: ["src/foo.ts"] }]`. Handler applies updates to the ledger.
- `server/src/providers/prompt/sections/task-ledger.ts` (NEW) — render the ledger as a section in the system prompt. Priority `103` (between env_info and reasoning_brief). Always visible.
  ```
  ═══ TASK LEDGER (what remains) ═══
  [✓] Scaffold project structure → package.json, vite.config.ts
  [~] Wire game logic into App.tsx → src/App.tsx (in progress)
  [ ] Add score-tracking with localStorage
  [ ] Write README with run instructions
  ═══
  ```
- `server/src/reasoning/reasoning-schema.ts` — extend `chunkReflectionBriefSchema` with optional `ledgerUpdates: Array<{ id, status, evidence }>`.
- `server/src/reasoning/pipelines/chunk-reflector-pipeline.ts` — system prompt asks the reflector to emit `ledgerUpdates` based on what just landed.
- Test: `task-ledger.test.ts` — seed from buildPlan, apply updates, render section, clear on run end.

**Stage 3 — Mandatory self-review chunks (forced read-back)**

Every N chunks of implementation, the system FORCES a non-write self-review: the agent reads back the last N chunks' files and reasons in `reasoningChain` about completeness BEFORE proceeding. Handler injects this as a synthetic tool-result with `═══ REVIEW REQUIRED ═══` context. Free-tier: N=2 chunks. Paid: N=4 chunks.

- `server/src/services/self-review-scheduler.ts` (NEW) — pure helper `shouldForceSelfReview({ chunkIndex, model, lastReviewIndex }): boolean`. Tracks cadence.
- `server/src/handlers/tool-result.ts` — at chunk boundary, if scheduler says review-required, inject a `═══ REVIEW REQUIRED ═══` block into the next tool-result. The block instructs:
  - `batch_read` of the last N chunks' files
  - mandatory `reasoningChain` covering: are the files coherent? do they match the buildPlan? what's missing? any contradictions with prior reasoning?
  - explicit instruction NOT to write anything this turn — only read + reason
- Server-side validation: the next response must NOT be a write_file / edit_file / batch_write. If it is, reject with a corrected prompt forcing the review.
- `server/src/services/free-tier-policy.ts` — `getSelfReviewCadence(model): number` — 2 for free-tier, 4 for paid.
- `server/src/services/flags.ts` — `quality.mandatory_self_review_enabled` (bool, default `true`).
- Test: `self-review-scheduler.test.ts` — cadence per tier, last-review tracking, edge cases.

**Stage 4 — Per-step (not per-chunk) divergence checks for free-tier**

Today's divergence detector fires at chunk boundaries. For free models, drift happens WITHIN chunks (3-4 turns of bad direction before the boundary fires). For free-tier, run the lightweight heuristic detector after EVERY tool result, not just chunk boundary.

- `server/src/handlers/tool-result.ts` — for free-tier runs, call `detectDivergence` after every tool-result (not just chunk boundary). Only the HEURISTIC detector — the LLM divergence stays at chunk boundaries (too expensive per-step).
- New per-step heuristic: `same_action_repeated_in_session` — if the same `{ tool, primaryPath }` tuple appears in the run more than 2 times within a 3-turn window, flag. Catches "agent retrying the same broken edit".
- Confidence tracker gets the per-step signals immediately, can cross threshold mid-chunk. Off-course modal fires earlier.
- `server/src/services/free-tier-policy.ts` — `shouldRunPerStepDivergence(model): boolean` — true for free-tier only (cost guard).
- `server/src/services/flags.ts` — `quality.per_step_divergence_for_free_tier` (bool, default `true`).
- Test: per-step detector matches per-chunk behaviour on the same input; the new heuristic catches repeated-same-action.

**Stage 5 — Reasoner-vs-action cross-check**

The agent's per-turn `reasoningChain` (PR #66) says *"I'm about to verify the import resolves by running grep"*, then the agent writes a new file instead. Nothing catches this disconnect today. Add a check: after each tool call, compare the action against the most recent `reasoningChain` entry. If the action doesn't plausibly fulfil the stated intent, fire a `reasoning_action_mismatch` signal.

- `server/src/services/reasoner-action-checker.ts` (NEW) — pure helper `crossCheckReasoningAction(lastReasoning: string, action: { tool, args }): { matches: boolean, reason?: string }`. Heuristics:
  - If reasoning mentions "verify", "check", "look", "investigate" → expect a read-only tool (run_command + safe, read_file, list_directory, search_*)
  - If reasoning mentions "write", "create", "scaffold", "implement" → expect a write/edit tool
  - If reasoning mentions "fix" + names a file → expect edit_file on that file (or read_file as precursor)
  - Mismatch when expected category and actual tool category don't match
- `server/src/services/divergence-detector.ts` — new `DivergenceCategory: "reasoning_action_mismatch"`. Severity: moderate (10 points). Fires when checker returns mismatches=true.
- `server/src/handlers/tool-result.ts` — wire the checker into the per-step divergence run (Stage 4 above).
- `server/src/services/flags.ts` — `quality.reasoning_action_cross_check_enabled` (bool, default `true`).
- Test: heuristic matrix — read-intent + read-action → match; read-intent + write-action → mismatch; etc.

## Migrations / data

N/A — all new state is in-memory per-run, cleared on run finalize.

## Hooks / skills / settings to update

- `server/src/services/flags.ts` registrations:
  - `quality.force_verify_after_write` (default `true`)
  - `quality.mandatory_self_review_enabled` (default `true`)
  - `quality.per_step_divergence_for_free_tier` (default `true`)
  - `quality.reasoning_action_cross_check_enabled` (default `true`)
- No `.claude/hooks/` changes. No skill changes.

## Dependencies

- No new packages.
- No new env vars.
- Cost: free-tier runs see ~1.3x more Flash calls (per-step divergence + chunk_reflect ledger updates). Acceptable per the user's stated priority (quality over budget).

## Risks & mitigations

- **Risk:** Verify-after-write block bloats the tool-result message and pushes the model to truncate. **Mitigation:** Block is short (≤ 200 tokens), inserted at the END of the tool-result so it's the LAST thing the model sees before writing its response. If a run carries 8+ chunks, the block fires per chunk so it never accumulates.
- **Risk:** Mandatory self-review breaks runs where the agent legitimately knows it's done early (3 chunks, simple task). **Mitigation:** Cadence skips review when fewer chunks have happened than N. Plus the review prompt explicitly says "if you genuinely have nothing to review, surface that in reasoningChain and continue".
- **Risk:** Per-step divergence false-fires on legitimate retries (e.g. fix-the-typo + verify). **Mitigation:** Same-action heuristic uses a 3-turn window AND requires same tool + same primary path. A legitimate "write then verify" cycle has different tools.
- **Risk:** Reasoner-vs-action cross-check is heuristic and noisy. **Mitigation:** Conservative — only fires on UNAMBIGUOUS mismatches (read-intent + write-tool is the clearest case). Severity `moderate` (10 points) means it has to fire multiple times to trip the off-course modal.
- **Risk:** Ledger updates from chunk_reflect get malformed and corrupt the ledger. **Mitigation:** Same repair pass pattern as `investigationPlan` (Stage 3 command-first) — filter malformed entries, leave the ledger unchanged if all updates are invalid.
- **Risk:** All five subsystems compound and free-tier runs become slow / expensive. **Mitigation:** Each subsystem is independently flag-gated. If profiling shows one is the bottleneck, disable it without affecting the others.

## Implementation order

1. **Stage 1 — Verify-after-write injector.** Smallest, highest direct impact on the "wrong implementations" failure mode. No new state across turns; pure injection into the next tool-result.
2. **Stage 2 — Persistent task ledger.** Closes the "AI forgot what to do" failure mode. New state but no new pipeline (extends chunk_reflect).
3. **Stage 3 — Mandatory self-review chunks.** Closes the "lacks checking every iteration" failure mode. Builds on Stage 2's ledger (review reads files referenced in ledger).
4. **Stage 4 — Per-step divergence for free-tier.** Catches drift WITHIN chunks. Builds on existing detector + tracker; just changes call cadence.
5. **Stage 5 — Reasoner-vs-action cross-check.** Catches the "model said X, did Y" disconnect. Smallest new code but composes with everything above.

Each stage = one PR off `main`. Stage labels: `feat(quality): Stage 1 — verify-after-write injector`, etc.

## Verification

**Stage 1**
- Unit: `buildVerifyAfterWriteBlock` returns expected commands for TS / JS / Python / mixed runs; platform-aware
- Unit: `shouldForceVerifyAfterWrite` matrix (free vs paid × complexity × file count)
- Manual: live-test claude-sonnet writing a 4-file chunk, observe the verify-after-write block appears in the next tool-result message, observe the agent runs `cat` / `npm run typecheck` before its next write

**Stage 2**
- Unit: ledger seeds from buildPlan, applies updates from chunk_reflect, renders cleanly in the system prompt section, clears on run end
- Unit: malformed `ledgerUpdates` payloads don't corrupt the ledger
- Manual: live-test, observe the `═══ TASK LEDGER ═══` block in the system prompt update across chunks

**Stage 3**
- Unit: `shouldForceSelfReview` cadence per tier; tracks `lastReviewIndex` correctly
- Unit: server-side validation rejects a write response when review was forced
- Manual: live-test free-tier run with 4 chunks, observe a forced review at chunk 2 and 4

**Stage 4**
- Unit: per-step detector matches per-chunk on the same input; new `same_action_repeated_in_session` heuristic catches the 3-times-same-tool case
- Manual: deliberately retry the same edit 3 times in a free-tier run, observe per-step signal fires before the chunk boundary

**Stage 5**
- Unit: cross-checker matrix (read-intent + read-action → match; read-intent + write-action → mismatch; etc.)
- Manual: live-test, observe the divergence signal when the model's reasoningChain says "verify" but it issues a write_file

## Out of scope

- **Auto-fix on verification failure** — if the verify-after-write block runs and finds a typecheck error, this plan doesn't auto-add a "fix this" step. The agent sees the error in tool-result and decides. Auto-fix is a future enhancement that needs more design (how to avoid loops).
- **Multi-run task ledger persistence** — the ledger is per-run. `/continue` across sessions doesn't carry the ledger forward (yet). The user can paste the prior ledger into the continuation prompt manually.
- **Reasoner-action cross-check on EVERY tool, not just write tools** — the cross-checker only flags read-intent + write-action mismatches. The inverse (write-intent + read-action) is usually legitimate setup; flagging it would be noisy. Future iterations can extend the heuristic if telemetry shows the noise floor is acceptable.
- **Off-course modal extension** — Phase 11's off-course modal already has continue / backtrack / redirect. Adding a "force re-review" option is desirable but not load-bearing — the mandatory self-review (Stage 3) achieves the same outcome via injection instead of a user prompt.
- **Per-LLM-call retry of the verify-after-write block** — if the block is injected but the model's next response still doesn't include verification commands, this plan doesn't re-inject. The agent's deviation is captured by the divergence detector and surfaces at the next chunk boundary instead.
