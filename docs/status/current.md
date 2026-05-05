# Current Project Status

> Last updated: 2026-05-02

## Recent Work

**Phase 8 persistent reasoning memory pass** (`.claude/plans/applied/2026-05-02-phase-8-persistent-reasoning-memory.md`):

The agent no longer re-deliberates the same decisions every fresh session. Phase 5 reasoning briefs + decision-tool outputs + completion summaries + user corrections now persist to a project-local `.sysflow-memory.md` (sibling of the user's hand-written `.sysflow.md`). **Anti-staleness is first-class** — every entry passes through three read-time validators before reaching the prompt.

- **`server/src/memory-store/`** *(new module)* — eight files:
  - `entry-schema.ts` — Zod envelope for entries: `{ id, kind, content, createdAt, lastConfirmedAt, lastUsedAt, sourceRef: { runId, trigger, filePaths, packageDeps }, status: 'active'|'stale'|'contradicted', useCount, contradictionCount, tags }`. `id` is sha256(kind+content) so re-records dedupe.
  - `file-format.ts` — markdown-with-frontmatter (HTML-comment-flavoured `<!--frontmatter ... frontmatter-->` block). Human-auditable, machine-parseable, tolerant of CRLF + extra whitespace + malformed entries.
  - `store.ts` — load (mtime-cached, walks one parent up for discovery) + save (atomic via temp+rename, Windows EPERM/EBUSY retry) + upsert (dedupe by id, bumps useCount on re-record).
  - `validators.ts` — three pure validators: **fileRefValidator** (every `sourceRef.filePaths` must exist), **depRefValidator** (every `sourceRef.packageDeps` must appear in `package.json`'s deps/devDeps/peerDeps/optionalDeps), **ageValidator** (60 days unconfirmed → stale, 180 days for high-use entries with useCount ≥ 5). `runAllValidators` partitions into `{ active, stale, contradicted }`.
  - `confirmation-tracker.ts` — `noteAgreement` bumps useCount + lastConfirmedAt; `noteContradiction` bumps counter and at threshold 2 flips status to 'contradicted' permanently; `noteAccessed` touches lastUsedAt only.
  - `compaction.ts` — at 100 KB serialised, drops contradicted → stale → low-use → oldest. **Never drops `user_correction`** entries (the user typed those — sacred).
  - `recall.ts` — `recallForReasoning(cwd, userMessage)` scores active entries by `recency*1 + useCount*3 + tokenOverlap*5 + 50-bonus-for-user-correction`, caps at 12.
  - `recorder.ts` — four best-effort writers: `recordDecision` (skips LOW confidence), `recordImplementSummary` (auto-adds stack libraries to packageDeps so dep-removal triggers stale), `recordUserCorrection` (always persists non-secret), `recordBugPattern`. All run a **secret-pattern guard** that refuses Stripe/AWS/Google/Slack/GitHub/PEM-shaped content.
- **Reasoner integration** — `gemini.ts buildPrompt()` calls `recallForReasoning` and threads `learnedMemoryLines + summary` into the new `learned_memory` prompt section (priority 106, between user-written project_memory at 105 and reasoning_brief at 107).
- **Handler integration** — `user-message.ts` persists implement briefs from preflight (HIGH/MEDIUM confidence + decision=proceed only). `tool-result.ts` persists summary briefs on completion + bug briefs on on-error trigger.
- **Slash commands**: `/memory list` (color-coded active/stale/contradicted with use count + age + last-confirmed + stale reasons), `/memory forget <id>`, `/memory clear stale`, `/memory clear all confirm` (literal 'confirm' word required), `/remember "..."`. CLI in `cli-client/src/commands/memory.ts` talks to the server's new `/memory/*` Fastify routes.
- **Five flags** (env-only kill switches): `prompt.learned_memory_enabled`, `memory.stale_after_days` (60), `memory.stale_after_days_high_use` (180), `memory.file_max_bytes` (102 400), `memory.max_recall_entries` (12).
- **~40 new test cases** across file-format roundtrip, store load/save/upsert + mtime cache + cache invalidation, all three validators + partition behaviour, confirmation lifecycle + contradiction-at-threshold, compaction eviction order + user_correction sanctity, recall ranking + filtering + secret refusal in recorder.

Targeted result: session 1 → reasoner picks Drizzle for ORM, persisted as a `decision` entry. Session 2 (next day, same project) → reasoner sees the entry in the prompt, doesn't re-deliberate, uses Drizzle. Session 3 → user removes drizzle-orm from package.json → on next read the dep-ref validator marks the entry stale → reasoner doesn't see it → asks fresh.

**Phase 7 background jobs pass** (`.claude/plans/applied/2026-05-02-phase-7-background-jobs.md`):

Install commands no longer block the agent. Previously `npm install` was in `SLOW_COMMAND_PATTERNS` and got skipped entirely — the agent literally couldn't install deps without user intervention. Phase 7 fixes both halves: install commands now run, *and* they run in the background.

- **`cli-client/src/agent/background-jobs.ts`** *(new)* — JobRegistry with `start/poll/list/wait/cleanupRun/forget`. Per-run cap of 3 concurrent jobs. 5-minute per-job watchdog. 30-second wait window on terminal exit before SIGTERM. Captures last 4 KiB of stdout + stderr per job.
- **New `BACKGROUND_BY_DEFAULT_PATTERNS`** carved out of `SLOW_COMMAND_PATTERNS`: npm/yarn/pnpm/bun install, pip install -r, bundle install, cargo build, go mod download. `runCommandTool` routes these to JobRegistry when `runId` is supplied. Agent can override either direction with the new optional `background` flag.
- **New `check_jobs` tool**: `{ jobId? }` returns either one job's state or the per-run job list (running first). Short-circuits in the executor — never goes through the server.
- **JobStatusBar** (`cli/job-status.ts`): pinned bottom-row indicator using direct ANSI cursor positioning. Refreshes every 1s. `⟳ npm install (12s)` while running → `✓ npm install (28s)` lingers 3s on success → `✖ npm install (5s — exit 1)` stays visible on failure. SIGINT handler clears the line cleanly. TTY check falls back to `console.log` for CI/pipes.
- **Agent loop wire-up**: `startJobStatusBar(runId)` at run start; `cleanupBackgroundJobs(runId)` on every terminal exit (waits up to 30s, then SIGTERMs); `RunSummary` extended with `backgroundJobsRun + backgroundJobsFailed` written to `usage.jsonl`.
- **Prompt updates**: `tools.ts` documents the `background` flag + adds tool 14 (`check_jobs`) with polling-cadence guidance; `task-guidelines.ts` rewrites the post-scaffold install instruction to "DON'T WAIT — start customising immediately, check_jobs after a few file ops".
- **Three new flags** (env-only kill switches): `cli.background_jobs_enabled`, `cli.max_concurrent_background_jobs`, `cli.background_job_timeout_ms`.
- **22 new test cases** across `background-jobs.test.ts` (start/poll/wait/cap/cleanup/forget) and `run-command-background.test.ts` (the routing decision matrix).

Targeted result: after a Phase 6 scaffold, `npm install` returns immediately with `{ jobId, status: 'running' }`; the agent customises App.tsx for the user's task while install runs in the background; bottom of the screen shows `⟳ npm install (NNs)`; agent calls `check_jobs` before completing to confirm install succeeded.

**Phase 6 scaffold-first pass** (`.claude/plans/applied/2026-05-02-phase-6-scaffold-first.md`):

Stop hand-writing config files for fresh projects when a canonical scaffolder exists. Resolved the system-prompt vs scaffold-options.ts contradiction.

- **New `server/src/scaffold/` module** — replaces `services/scaffold-options.ts` (deleted). Contains:
  - `registry.ts`: 22 canonical scaffolders covering Vite-family (React/Vue/Svelte/Solid/Preact/Lit/Vanilla), full-stack frameworks (Next/Nuxt/SvelteKit/Remix/Astro/Qwik), backend (Nest/Angular), desktop+mobile (Expo/Tauri/Electron-Vite), runtimes (Bun init), non-Node (Django/Laravel/Rails). Each entry pre-bakes non-interactive flags.
  - `recommender.ts`: pure `recommendScaffold(brief, cwd, directoryTree)` consumes the Phase 5 implement brief. Three gates: fresh-project, implement-pipeline brief present, registry match. Returns `{ shouldScaffold, scaffolder, candidates, projectName, autoTrust, reason }`. autoTrust requires HIGH confidence + exactly one match + the entry's `autoTrustForHighConfidence` flag.
  - `project-name.ts`: extracts kebab-case project names from prompts ("create a todo list app" → `todo-list`); falls back to cwd basename, then `my-app`.
  - `legacy-shims.ts`: keeps the existing multi-candidate `waiting_for_user` flow working.
- **Auto-trust path** in `handlers/user-message.ts`: when the recommender returns `autoTrust: true`, the handler skips the model call entirely and synthesizes a `needs_tool` response with `run_command` + the resolved scaffolder command. Post-scaffold guidance is queued via `actionPlanner.injectContext` so the next turn knows to read package.json, run `npm install`, and customise (not recreate).
- **Post-scaffold safety net** in `handlers/tool-result.ts`: detects scaffolder commands by pattern (npm create, npx create-, npx @nestjs/cli new, etc.) and on success injects the same post-scaffold guidance. Catches the user-confirmed multi-candidate path too.
- **COMMANDS prompt rewrite** in `task-guidelines.ts`: removed the line that previously forbade `npx <scaffolder> init` (it contradicted the scaffold-options system). New guidance actively encourages scaffolders for fresh projects, lists 16 stacks, requires running `npm install` during the run (not deferred to summary), and warns against recreating generated files.
- ~25 new test cases across `registry`, `project-name`, `recommender`.

Targeted result: `sys "create a react app for a todo list"` in an empty directory → reasoning brief renders showing React+Vite + HIGH confidence; `npm create vite@latest todo-list -- --template react-ts` runs without a user prompt; permission system asks once for `npm install`; agent then customises App.tsx.

**Phase 5 reasoning system pass** (`.claude/plans/applied/2026-05-02-phase-5-pre-flight-reasoning.md`):

Built-in reasoning system that fires across four lifecycle triggers, each with its own pipeline:

- **Pre-flight** (`handlers/user-message.ts`): every fresh prompt runs through `runReasoning({ trigger: 'preflight' })`. The intent classifier short-circuits trivial prompts (`"list files in src"`) without a model call. Implement-shaped prompts get the implement pipeline (stack + rationale + missing context detection); the canonical "create an automation for spreadsheet" prompt now asks for Sheet ID + service-account JSON + reminds the user to share with the service-account email *before* writing code.
- **Self-invoked** (`reason` tool + `POST /reason` endpoint): the agent calls `reason({ kind, question, context, options })` mid-execution when it hits a fork (library choice, deletion safety, architectural pattern). The decision pipeline returns `{ recommendation, alternatives with fitScore, riskNotes, proceedHint }`. Hard cap at 5 calls per run (flag-tunable); recursion guard prevents reasoning-about-reasoning.
- **On-error** (`handlers/tool-result.ts`): after 2 consecutive tool failures the bug pipeline runs with the failing context. Brief is injected into the next provider call so the agent benefits from ranked hypotheses + invalidating tests + a minimal-safe proposed fix. Cap at 2 reasoning calls per run.
- **On-completion** (`handlers/tool-result.ts`): non-trivial runs (≥5 actions OR ≥3 files modified) get their final user-facing message refined by the summary pipeline. Replaces the draft with clusters + what-matters + verification steps.

Architecture:

- `server/src/reasoning/` — new module: `reasoning-schema.ts` (Zod discriminated envelope), `meta-rules.ts` (six cross-cutting principles), `intent-classifier.ts` (cheap regex hint), `task-reasoner.ts` (orchestrator + recursion guard), `reasoning-cache.ts` (sha256-keyed, 30-min TTL, FIFO 200), `critical-context-detector.ts` (cross-check + prune), `examples.ts` (28 few-shot examples), `pipelines/{implement,bug,summary,decision}-pipeline.ts`.
- All reasoning calls run on Gemini Flash regardless of the main model — cheap + fast and consistent.
- `prompt/sections/reasoning-brief.ts` — non-cacheable section that renders pipeline-specific guidance for the main agent.
- `cli/reasoning-display.ts` — terminal renderer with confidence color-coding (HIGH=green, MEDIUM=yellow, LOW=red); inline collapsed for self-invoked decisions, full box for the other triggers.
- 37 new test cases across `reasoning-schema`, `intent-classifier`, `reasoning-cache`, `critical-context-detector`.
- Seven new flags (env-only kill switches; all default true / sensible values).

The CONFIDENCE-AWARE rule is now operational: HIGH = act, MEDIUM = call `reason` if reversal is expensive, LOW = always reason then ask if still LOW.

**Phase 4 productionisation pass** (`.claude/plans/applied/2026-05-02-phase-4-productionisation.md`):

- **Feature flag system**: typed registries on both server (`server/src/services/flags.ts`) and CLI (`cli-client/src/agent/flags.ts`) with three-source precedence (`SYSFLOW_FLAG_<NAME>` env > `<sysbasePath>/flags.json` > registered default). Per-process memoisation; `resetFlagCache()` for tests. Initial inventory wires existing constants: `compaction.autocompact_threshold_buffer`, `compaction.microcompact_keep_last_n`, `tool.persist_threshold_bytes`, `cli.tool_result_preview_enabled`, `cli.diff_preview_lines_max`, `cli.retry_max_default`, `cli.audit_retention_days`.
- **Plan mode**: new `prompt/sections/plan-mode.ts` injects a plan-aware section when `planMode === true`. `getPlanMode()`/`setPlanMode()` persist the flag in `models.json`. `/plan-mode [on|off]` slash command toggles it; the REPL header shows `plan-mode` when active. Pairs with the existing `PermissionMode = 'plan'` from Phase 3.
- **Daily-rotated audit log**: `cli-client/src/agent/audit-log.ts` writes to `<sysbasePath>/audit-YYYY-MM-DD.jsonl` and prunes files older than `cli.audit_retention_days` (default 14) on the first call after the date changes. The `builtin/audit` hook now uses it.
- **Per-run usage telemetry**: `agent/usage-log.ts` appends one JSONL line per terminal run-exit to `<sysbasePath>/usage.jsonl` with `runId, prompt (200-char preview), model, durationMs, stepCount, toolCount, errorCount, estimated input/output tokens, terminalReason`. Wired into every terminal branch in the CLI agent loop.
- **Initial test suite**: vitest set up on both packages with `npm test` / `test:watch` scripts. ~30 cases land across `validate-tool-input` (12), `permissions` (10), `hooks` (6), `tool-meta` (8), `context-budget` (12), `project-memory` (6), `tool-error-classifier` (10). All target the pure modules from Phases 1–3 — no network, no DB.

**Phase 3 capabilities pass** (`.claude/plans/applied/2026-05-02-phase-3-capabilities.md`):

- **Zod tool input schemas**: `cli-client/src/agent/tool-schemas.ts` declares one Zod schema per tool (read_file, batch_read, list_directory, file_exists, create_directory, write_file, edit_file, move_file, delete_file, search_code, search_files, run_command, web_search, batch_write). edit_file is a discriminated union of its four valid shapes. `validateToolInput()` returns either parsed args or a structured ValidationError with the failing field path, all issues, and a recovery hint. Wired into the executor; replaces the manual `if (!args.path)` chains.
- **Permission system**: modes (`default | auto | plan | bypass`) persisted in `models.json`. `agent/permissions.ts` exposes `checkPermissions()` consulting mode > rules > per-tool defaults; persistent rules in `<sysbasePath>/permissions.json` (longest-pattern wins). Run-scoped session cache remembers ask-answers so the user only confirms once per (tool, path) per run. Interactive `cli/permission-prompt.ts` gives 4 options (allow once / Allow always / deny once / Deny always). `/mode <name>` and `/permissions [list|remove n|clear]` slash commands.
- **Hook registry**: `agent/hooks.ts` with `pre_tool_use`, `post_tool_use`, `post_tool_use_failure` events. Hooks can `override` the permission decision, `prevent` execution, or add audit notes. `agent/builtin-hooks.ts` ships two hooks enabled by default — `builtin/secrets-block` denies writes to `.env*`, `*.pem`, `id_rsa*`, `secrets.{json,yaml,toml}`, `credentials.*` (with `.example`/`.sample`/`.template` allowlisted), and `builtin/audit` appends JSONL entries to `<sysbasePath>/audit.jsonl`.
- **Server passthrough**: `classifyToolErrorFromResult()` trusts the CLI's `_errorCategory` field instead of re-deriving from the error string, so the model gets the structural validation/permission hint without double-prefixing.

**Phase 2 foundation pass** (`.claude/plans/applied/2026-05-02-phase-2-foundation.md`):

- **Tool-error classifier**: `services/tool-error-classifier.ts` returns one of validation | permission | file_not_found | file_too_large | timeout | command_failed | command_not_found | network | auth | unknown plus a tool-specific recovery hint that's appended to the AI's tool result. Replaces the regex-only legacy hint table for any error the classifier recognises.
- **Project memory file**: `services/project-memory.ts` discovers `.sysflow.md` (preferred) or `CLAUDE.md` (fallback) in cwd, parent dir, and `~/.sysflow/MEMORY.md`. New `prompt/sections/project-memory.ts` injects discovered content into the prompt's dynamic half. Memoised by mtime, hard-capped at 50k chars combined, skips files matching common secret patterns. `cwd` is now plumbed through `ProviderPayload`.
- **Real autocompact**: `compactConversationSummary()` asks the model to produce a structured markdown summary (original task / files touched / decisions / current state / unresolved) and replaces chat history with a single summary turn. Singleton `AutocompactCircuitBreaker` opens after 3 consecutive failures per run. Recursion guard prevents summary-of-summary calls.
- **Max-output-token recovery**: `BaseProvider.nextMaxOutputAction(runId)` returns `escalate` | `continue` | `fail` per attempt (max 3). Gemini provider's new `sendWithMaxOutputRecovery` wraps `chat.sendMessage`; on `finishReason === 'MAX_TOKENS'` it issues a continuation prompt and concatenates partial text until the model finishes or the limit hits.
- **Tool-result archival**: `store/tool-result-persistence.ts` writes results larger than 10 KiB to `<sysbasePath>/tool-results/<runId>/<toolId>.json` as full pre-budget payloads. Best-effort, never throws. Budget-clamped result gains `_persistedPath` + `_persistedSize`.
- **Concurrency partitioning + sibling abort**: `cli-client/src/agent/tool-meta.ts` is the single source of truth for per-tool flags (`isConcurrencySafe`, `isReadOnly`, `abortsSiblingsOnError`). `executor.ts` uses `partitionToolCalls()` and short-circuits serial siblings with `aborted_by_sibling: true` when a `run_command` fails. CLI preview renders `↯ aborted` for those.

**Phase 1 reasoning + CLI UX pass** (`.claude/plans/applied/2026-05-02-phase-1-reasoning-and-cli-ux.md`):

- **Modular system prompt**: extracted the monolithic `SHARED_SYSTEM_PROMPT` into priority-sorted sections under `server/src/providers/prompt/sections/` (identity, system rules, tools, task guidelines, output efficiency, env info, model-specific) joined by an explicit `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` marker so future provider-side caching can split on it.
- **Context budget**: new `server/src/services/context-budget.ts` exposes `estimateTokens`, per-tool `TOOL_RESULT_MAX_CHARS`, `applyToolResultBudget`, and `microcompactGeminiHistory`. Wired into both handlers + Gemini chat-history rebuild.
- **Pre-API token guard**: `user-message.ts` and `tool-result.ts` reject oversized payloads with `errorCode: 'prompt_too_long'` before calling the provider.
- **Schema fixes**: Gemini `RESPONSE_SCHEMA` now includes `waiting_for_user` in `kind` and a `taskPlan` property.
- **Malformed-response cap**: `parseJsonResponse` tracks per-run failures and returns `failed` after 2 in a row instead of silently coercing to `list_directory` forever.
- **CLI refactor**: `cli-client/src/agent/agent.ts` (was 1160 lines of mixed concerns) now imports rendering primitives from `cli/render.ts`, diff-Tab handling from `cli/diff-preview.ts`, tool-result previews from `cli/tool-result-preview.ts`, and dispatches transitions through `agent/state-machine.ts` with retry budgets in `agent/retry.ts`.
- **Tool-result preview**: each tool now prints a short preview line (first 3 lines for reads, exit code + last stdout line for commands, match count for searches) instead of dropping straight back into the spinner.

Earlier completed work:

- Converted all CLI modules to TypeScript (agent, commands, CLI, lib)
- Fixed TypeScript errors in server tool-result and billing routes
- Updated README to reflect TypeScript migration

## What's Done

- Full server with Fastify 5.x, routes, handlers, providers, stores
- PostgreSQL schema with 9 migrations (auto-run on startup)
- Multi-provider AI system (Gemini, OpenRouter functional; Claude Sonnet/Opus **mocked**)
- SWE mock provider for demo/testing (deterministic 20+ step auth system build)
- CLI client with agent loop, 11 tools, interactive UI
- Authentication (register, login, JWT with 30-day expiry)
- Billing integration (Stripe checkout, webhooks, SSE stream, 4 plans)
- Chat session management with project scoping
- Context auto-save system (memories on success, fixes on failure)
- Fix files auto-written to `sysbase/fixes/` on failed tasks
- File mention syntax (`@filepath`) in prompts
- TypeScript migration complete (strict mode, ES2022)

## What's NOT Done / Needs Work

- **Claude Sonnet provider**: Returns mock responses (TODO in code)
- **Claude Opus provider**: Returns mock responses (TODO in code)
- **docs/ still reference .js files**: docs/server.md and docs/cli-client.md show `.js` extensions (pre-migration)
- **No refresh token mechanism**: JWT expires after 30 days, no renewal
- **Default JWT_SECRET is weak**: `"sysflow-secret-change-me"` in production default

## Branch State

- **Main branch**: clean, all committed
- Latest commit: `ecd647f` — docs: update README for TypeScript migration

## Known Architecture Notes

- In-memory stores (runs, tasks, tool-results, memory) **reset on server restart**
- Only `openrouter-auto` and `gemini-flash` are visible in CLI model picker
- Tool execution has a 30-second timeout on `run_command`
- Server has a 5-minute per-request timeout
- `edit_file` tool does full file replacement, not diff-based editing
- Long-running commands (npm start, etc.) are detected and skipped by CLI
- Free plan tracks prompts via `free_prompts_today`/`free_prompts_reset_at` on users table
- Paid plans use credit system (NUMERIC cents in DB)
- Session history limited to 20 entries in AI prompts, 50 in chat view
- Orphaned sessions (from interrupted runs) are auto-saved as "interrupted"
