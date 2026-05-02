# Sysflow Phase 4 — Productionisation

- **Created:** 2026-05-02
- **Status:** implemented (2026-05-02)
- **Scope:** Make Sysflow production-shaped: typed feature flags, a plan-mode toggle that uses the existing `plan` permission mode + a plan-aware prompt section, an initial vitest suite over the pure modules from Phases 1–3, daily rotation for the audit log, and a per-run usage summary appended to `<sysbasePath>/usage.jsonl`.

## Goal

Turn the orchestrator into something that's safe to ship, debug, and roll changes through. No new agent capabilities — this round is about flags, a real test suite, plan mode (so the user can review before letting Sysflow touch the disk), and the operational artefacts (rotated audit logs + usage telemetry) that past phases promised but didn't deliver.

## Context from knowledge base

`.claude/knowledge/` is still empty. References that matter for this slice:

- `docs/sysflow-improvement/12-testing-reliability.md` — feature flags + tests. Phase 4 lands the flag system + the seed test suite; the wider "tests on every subsystem" remit stays open.
- `docs/sysflow-improvement/01-agent-loop.md` (priority 3) — plan mode is mentioned as a separate mode in Claude Code. Our implementation reuses the existing `PermissionMode = "plan"` from Phase 3 and adds a prompt section + slash command rather than a new tool — closer to a UX flag than a queryLoop change.
- `.claude/plans/applied/2026-05-02-phase-2-foundation.md` — added `services/project-memory.ts` with mtime caching; the same pattern applies to feature-flag config caching.
- `.claude/plans/applied/2026-05-02-phase-3-capabilities.md` — Phase 3 introduced `<sysbasePath>/audit.jsonl`, `permissions.json`, `models.json`. Phase 4 adds `flags.json`, `usage.jsonl`, and rotated `audit-YYYY-MM-DD.jsonl` files alongside.

## Affected files

### Server + CLI — Feature flag system

- `server/src/services/flags.ts` *(new)* — typed registry: `defineFlag<T>(name, default)`. `getFlag(name)` reads `process.env.SYSFLOW_FLAG_<NAME>` first (cast via the flag's parser), then `<sysbasePath>/flags.json` (when the caller supplies sysbasePath), else the registered default. Memoised per-process; invalidated by an explicit `resetFlagCache()` (used in tests). Initial flag inventory: `compaction.autocompact_threshold_buffer` (number), `compaction.microcompact_keep_last_n` (number), `tool.persist_threshold_bytes` (number), `prompt.dynamic_boundary_enabled` (boolean), `prompt.frontend_section_only_when_relevant` (boolean — reserved for a follow-up; default false today).
- `cli-client/src/agent/flags.ts` *(new)* — same registry shape on the CLI side; CLI-only flags: `cli.tool_result_preview_enabled` (bool), `cli.diff_preview_lines_max` (number), `cli.retry_max_default` (number).
- `server/src/services/context-budget.ts` — read `compaction.autocompact_threshold_buffer` and `compaction.microcompact_keep_last_n` from the flag registry instead of hardcoded constants.
- `server/src/store/tool-result-persistence.ts` — read `tool.persist_threshold_bytes` from the registry; default unchanged (10 KiB).
- `cli-client/src/cli/tool-result-preview.ts` — wrap the preview output in a `if (!flags.cli.tool_result_preview_enabled) return null` short-circuit so users can disable the line.
- `cli-client/src/agent/retry.ts` — `withRetry` reads `cli.retry_max_default` for `maxRetries` when not explicitly passed.

### CLI — Plan mode

- `server/src/providers/prompt/sections/plan-mode.ts` *(new)* — non-cacheable section that, when `planMode === true`, asks the model to ONLY output a `taskPlan` (no `needs_tool` other than read/search), wait for explicit user confirmation before mutating files, and use bullet form summaries.
- `server/src/providers/prompt/build.ts` — register the new section at priority 108 (after env/project memory, before model-specific). `PromptCtx` gains `planMode?: boolean`.
- `server/src/types.ts` — `ProviderPayload.planMode?: boolean` (already plumbed through providers via `cwd`-style passthrough).
- `server/src/handlers/user-message.ts` + `server/src/handlers/tool-result.ts` — populate `planMode` on the provider payload from the request body.
- `server/src/providers/gemini.ts` — pass `planMode` into `getSystemPrompt()` from `buildPrompt(payload)`.
- `cli-client/src/lib/sysbase.ts` — `getPlanMode()` / `setPlanMode()` persist a boolean in `models.json` next to `permissionMode`.
- `cli-client/src/agent/agent.ts` — when plan mode is on, set `serverPayload.planMode = true`. Also, when the active permission mode is `default` and plan mode is on, automatically use the `plan` permission mode for the duration of the run (without persisting).
- `cli-client/src/cli/parser.ts` — register `/plan-mode [on|off]` (toggle when no arg).
- `cli-client/src/cli/ui.ts` — wire `/plan-mode`; show plan-mode status in the header.
- `cli-client/src/commands/permissions.ts` — `showPermissions()` gets a "plan mode" line for visibility.

### Audit log rotation

- `cli-client/src/agent/audit-log.ts` *(new)* — `appendAudit(sysbasePath, entry)` writes to `<sysbasePath>/audit-YYYY-MM-DD.jsonl` (today's date in local timezone). On first call per day, it scans the directory and deletes files older than `cli.audit_retention_days` (new flag, default 14). Pure file I/O — best-effort, never throws.
- `cli-client/src/agent/builtin-hooks.ts` — replace the current `fs.appendFile(<sysbasePath>/audit.jsonl, ...)` call with `appendAudit(...)`. Existing audit.jsonl from before this change keeps working (read by debugging tools); new entries land in the dated files.

### CLI usage telemetry

- `cli-client/src/agent/usage-log.ts` *(new)* — `recordRunSummary(sysbasePath, summary)` appends one JSONL line per completed run: `{ ts, runId, prompt (first 200 chars), model, durationMs, stepCount, toolCount, errorCount, estimatedInputTokens, estimatedOutputTokens, terminalReason }`. Best-effort; never throws.
- `cli-client/src/agent/agent.ts` — accumulate counters during `runAgent` (already mostly in scope) and call `recordRunSummary()` on every terminal exit (success or failure). Reuse `estimateTokens` from server's context-budget by re-implementing a tiny client-side mirror — the CLI shouldn't depend on server source.
- `cli-client/src/agent/token-estimate.ts` *(new)* — 6-line `estimateTokens(s)` helper (chars/4) used by `usage-log.ts` and any other CLI module that needs a rough count. Keeps the CLI dependency-free.

### Tests

- `cli-client/package.json` + `server/package.json` — add `vitest` to devDependencies, `"test": "vitest run"` script, `"test:watch": "vitest"`.
- `cli-client/vitest.config.ts` *(new)* — points to `src/**/*.test.ts`, node environment.
- `server/vitest.config.ts` *(new)* — same.
- `cli-client/src/agent/__tests__/validate-tool-input.test.ts` *(new)* — Zod schemas accept good payloads and reject bad ones; check the ValidationError shape (field, expected, hint) for read_file, edit_file (each of the 4 union shapes), search_files (the refine), batch_read.
- `cli-client/src/agent/__tests__/permissions.test.ts` *(new)* — checkPermissions branches: bypass allows everything, plan denies non-read tools, longest-pattern wins for rules, per-tool defaults fall through. matchesGlob() unit tests for `*`, `**`, literal escapes, edge cases.
- `cli-client/src/agent/__tests__/hooks.test.ts` *(new)* — runHooks ordering, first-override-wins, prevent short-circuit, audit hooks always observe even after prevent.
- `cli-client/src/agent/__tests__/tool-meta.test.ts` *(new)* — partitionToolCalls puts read tools in parallel and run_command in serial; batchHasSiblingAborter is true iff any tool aborts siblings.
- `server/src/services/__tests__/context-budget.test.ts` *(new)* — estimateTokens math, applyToolResultBudget truncates the largest string field and sets `_truncated`, microcompactGeminiHistory keeps last 5 tool turns and clears older ones, AutocompactCircuitBreaker opens after 3 failures, isInsideAutocompactCall recursion guard.
- `server/src/services/__tests__/project-memory.test.ts` *(new)* — discoverProjectMemory reads from cwd, parent, falls back to CLAUDE.md when .sysflow.md is missing, respects the secret allow-list, hard-cap truncation. Uses node:os.tmpdir for fixtures.
- `server/src/services/__tests__/tool-error-classifier.test.ts` *(new)* — classifyToolError returns the right category + hint for ENOENT, EACCES, timeouts, "command not found", auth errors, validation errors, falls through to 'unknown'. classifyToolErrorFromResult honours `_errorCategory`.

### Docs

- `docs/status/current.md` — Recent Work entry for Phase 4.
- `docs/sysflow-improvement/14-complete-gap-checklist.md` — check off Testing & Reliability (tests, feature flags), Streaming & Performance (configurable concurrency stays open but flags now exist).

## Migrations / data

N/A. New on-disk artefacts: `<sysbasePath>/flags.json` (optional, manual), `<sysbasePath>/usage.jsonl` (append-only), `<sysbasePath>/audit-YYYY-MM-DD.jsonl` (rotated daily). Old `<sysbasePath>/audit.jsonl` is left in place — it just stops growing.

## Hooks / skills / settings to update

`<sysbasePath>/models.json` gains `planMode: boolean`. Default false when missing. No `.claude/settings.json` changes.

## Dependencies

- `vitest ^2.1.x` added to **both** `cli-client/devDependencies` and `server/devDependencies`. No runtime deps.
- New optional env var: `SYSFLOW_FLAG_<NAME>` (one per registered flag). Tests can toggle via `process.env`.

## Risks & mitigations

- **Vitest config mismatch with the existing TS strict + ESM module resolution.** → Both packages are ESM (`"type": "module"`); vitest 2.x supports it natively. `vitest.config.ts` uses `defineConfig({ test: { environment: 'node' }})` — no transform needed because TS files run via vitest's built-in transformer.
- **Flag system changing default behaviour without warning.** → All flag defaults match the current hardcoded values. No behavioural change unless the user sets the env var or the JSON file.
- **Plan mode collides with user's existing scaffold-confirmation flow.** → Plan mode just *additionally* injects a prompt section and tightens permissions; the existing scaffold confirmation runs orthogonally.
- **Audit-log rotation deletes a file the user wanted.** → Default retention is 14 days. The cleanup only runs once per day (when the date changes vs. the last-seen filename); it never runs from inside a tool execution, so partial deletions don't strand the run.
- **Usage telemetry leaks the user's prompt to disk.** → It already lands in DB/sessions; we cap to the first 200 chars and the file lives under `<sysbasePath>` (gitignored, per-project).

## Implementation order

Each step compiles green and is independently revertable. Tests at the end so the modules they cover are stable.

1. **Server flag registry** — `services/flags.ts`. Pure; no callers yet.
2. **CLI flag registry** — `agent/flags.ts`.
3. **Wire flags into existing constants** — context-budget thresholds, persistence threshold, retry max, tool-result preview enable.
4. **Plan-mode plumbing** — section file, build.ts registration, `planMode` on PromptCtx + ProviderPayload, handler passthrough, Gemini buildPrompt arg, sysbase getter/setter, agent.ts payload field.
5. **Plan-mode UX** — slash command + ui.ts dispatch + showPermissions visibility.
6. **Audit-log rotation** — `audit-log.ts` with daily files + retention cleanup; swap builtin-hooks audit hook to use it.
7. **Usage telemetry** — `usage-log.ts` + `token-estimate.ts`; agent.ts call on every terminal exit.
8. **Vitest setup + first tests** — config files, scripts, validate-tool-input + permissions + hooks + tool-meta tests.
9. **Server-side tests** — context-budget + project-memory + tool-error-classifier.
10. **Docs + checklist update.**

## Verification

- **Compile:** `tsc --noEmit` clean in both `cli-client/` and `server/`.
- **Tests:** `npm test` in both packages — at least 30 cases passing across the new files. Coverage spot-checks (no coverage tool yet — manual count of asserted behaviours).
- **Manual smoke:**
  - Toggle `/plan-mode on`, send a prompt that would normally write — confirm the model only proposes a plan.
  - Set `SYSFLOW_FLAG_TOOL_PERSIST_THRESHOLD_BYTES=1024` and run a `read_file` of a 5 KiB file — confirm the result is archived even though it's under 10 KiB.
  - Run two prompts on different days — confirm two `audit-YYYY-MM-DD.jsonl` files exist.
  - After a successful run, confirm a new line exists in `<sysbasePath>/usage.jsonl` with the run summary.

## Follow-ups (post-Phase 4)

- True async-generator queryLoop + streaming tool execution (the big rewrite).
- Multi-agent coordinator + sub-agent spawning + inter-agent messaging (`AgentTool`, `SendMessage`).
- MCP integration.
- Zod *output* schemas + tool-result validation on the CLI side.
- Coverage tooling.
- Sessions API extension — drive usage telemetry from the server too (currently CLI-only).

## Completion notes

Implemented 2026-05-02. All 10 ordered steps executed in sequence, pushed as 9 separate feature/test/docs commits.

**Deviations from the plan:**

- The plan called for auto-flipping the active `PermissionMode` to `plan` whenever `planMode` is on. Implementing that cleanly required threading a per-run override through `resolvePermission()` in the CLI executor — more invasive than the plan accepted for one session. Punted: the user can manually `/mode plan` alongside `/plan-mode on`. Plan mode + permission mode show together in `/permissions` for discoverability.
- Plan-mode flag isn't propagated on `tool_result` payloads from the CLI — only on the initial `user_message`. Gemini's chat session keeps the original `systemInstruction` (with the plan-mode section baked in) across tool turns, so the model still knows. The microcompact rebuild path *does* re-read `payload.planMode`, so a microcompact mid-plan-mode could lose the section; this is an edge case worth fixing in the next pass.
- Built-in hooks load from `agent/builtin-hooks.ts` only. The plan reserved `.claude/hooks/` external hooks but punted them; that pairs better with a Phase 5 extension API.

**Surprises:**

- vitest 2.x picks up TS files via its own transformer with no extra config; the `vitest.config.ts` in both packages is just `defineConfig({ test: { environment: 'node', include: [...] } })`. No swc/esbuild plumbing needed despite both packages being ESM strict-mode TypeScript.
- The `RetryOptions` getter pattern (`get maxRetries() { return defaultMaxRetries() }`) lets the flag value rehydrate per-call without changing the public interface. Cleaner than passing the flag through every call site.
- `audit-log.ts`'s `lastDate` cache means the prune scan only happens once per day per process, even if a single agent run spans hundreds of tool calls — important because the directory could have 14+ files to stat.

**Knowledge to capture (next pass):**

- "Three-source flag precedence: env > sysbase JSON > registered default" → `.claude/knowledge/patterns.md`.
- "Vitest config is a 6-line file for both packages" → `.claude/knowledge/patterns.md`.
- "Plan-mode + permission-mode are independent toggles" → `.claude/knowledge/decisions.md`.
