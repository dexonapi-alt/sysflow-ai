# Sysflow Phase 7 — Background Jobs

- **Created:** 2026-05-02
- **Status:** implemented (2026-05-02)
- **Scope:** Let install-class commands (`npm install`, `pnpm install`, `yarn install`, `bun install`, `pip install -r`, `bundle install`, `cargo build`) run in the background while the agent continues working. New JobRegistry + `check_jobs` tool + bottom-of-screen status indicator. Auto-background by default for install patterns; foreground stays the default for everything else.

## Goal

Today, after a Phase 6 scaffold the agent has to run `npm install` and **wait 30+ seconds** doing nothing. Worse: in the current `tools.ts`, `npm install` is in `SLOW_COMMAND_PATTERNS` and is **auto-skipped entirely** — the agent can't actually install deps at all without user intervention. Phase 7 fixes both: install commands now run in the background, the agent keeps working (read package.json, customise files), and the CLI shows a pinned status line `⟳ npm install (12s)`. When the job finishes the agent sees it via `check_jobs` (or the next response includes a job-completion event).

## Context from knowledge base

`.claude/knowledge/` is still empty. Relevant references:

- `cli-client/src/agent/tools.ts` lines 582–601 — `LONG_RUNNING_PATTERNS` (servers — block forever, refused) and `SLOW_COMMAND_PATTERNS` (install commands — currently auto-skipped). Phase 7 carves install patterns OUT of `SLOW_COMMAND_PATTERNS` into a new `BACKGROUND_BY_DEFAULT_PATTERNS` and runs them in the background instead of skipping.
- `cli-client/src/agent/tool-schemas.ts` — Zod schemas. `runCommandSchema` gains optional `background: boolean`. New `checkJobsSchema` for the polling tool.
- `cli-client/src/agent/tool-meta.ts` — Phase 3 metadata. `check_jobs` is `isConcurrencySafe: true, isReadOnly: true, defaultPermission: 'allow'`.
- `cli-client/src/agent/executor.ts` — dispatch switch for tools. Add `check_jobs` case alongside the existing `reason` short-circuit.
- `cli-client/src/cli/render.ts` + `cli/tool-result-preview.ts` — for the status indicator we'll likely use the existing `ora` dep (already a runtime dep) with a separately-pinned spinner that lives below the main agent output.
- `.claude/plans/applied/2026-05-02-phase-6-scaffold-first.md` — established `getInstallCommand()` and the post-scaffold guidance that tells the agent to run `npm install`. Phase 7 makes that call cheap.
- `.claude/plans/applied/2026-05-02-phase-3-capabilities.md` — permission system. Background `npm install` still flows through the permission gate (the agent's `run_command` request is gated normally; only the EXECUTION shape changes).

## Affected files

### CLI — JobRegistry

- `cli-client/src/agent/background-jobs.ts` *(new)* — `JobRegistry` class. `start({ command, cwd, runId, label })` spawns the process via `child_process.spawn` (mirroring the existing `runCommandTool` shell pattern), generates a `jobId`, stores `{ id, command, cwd, label, status: 'running'|'done'|'failed', startedAt, endedAt?, exitCode?, stdoutTail (last 4KB), stderrTail (last 4KB), durationMs }` in a per-runId Map. Returns the job synopsis immediately. `poll(jobId)` returns the current state. `list(runId)` returns all jobs for a run (running first). `wait(jobId, timeoutMs)` resolves when the job exits or times out. `cleanupRun(runId)` after terminal exit: gives outstanding jobs `WAIT_TIMEOUT_MS` (default 30s) to finish, then SIGTERMs the rest and marks them `failed: aborted`. Hard caps: `MAX_CONCURRENT_PER_RUN = 3` (start() throws when exceeded), `MAX_JOB_DURATION_MS = 5 * 60_000` (per-job watchdog SIGTERMs after 5min).

### CLI — runCommandTool background path

- `cli-client/src/agent/tools.ts` —
  1. Carve install patterns out of `SLOW_COMMAND_PATTERNS` into a new `BACKGROUND_BY_DEFAULT_PATTERNS` array (npm/pnpm/yarn/bun install, pip install -r, bundle install, cargo build).
  2. `runCommandTool(command, cwd, opts?)` gains an optional `opts: { background?: boolean, runId?: string, label?: string }`. Logic:
      - If `opts.background === true` OR (background flag absent AND command matches `BACKGROUND_BY_DEFAULT_PATTERNS`): hand off to `JobRegistry.start(...)` and return `{ jobId, status: 'running', startedBackground: true, command, message: "Started in background. Use check_jobs to poll." }`.
      - Otherwise: existing synchronous path.
  3. Keep prisma/shadcn/tailwindcss patterns in `SLOW_COMMAND_PATTERNS` (those genuinely should be skipped — they're config-init commands the user should own).
  4. Don't background a command that ALSO matches `LONG_RUNNING_PATTERNS` (servers) — those are still refused.

### CLI — tool dispatch + schemas + meta

- `cli-client/src/agent/tool-schemas.ts` —
  - Extend `runCommandSchema`: `.extend({ background: z.boolean().optional() })`.
  - New `checkJobsSchema`: `z.object({ jobId: z.string().min(1).optional() }).strict()` — omitting `jobId` lists all jobs.
  - Register `check_jobs: checkJobsSchema` in `TOOL_SCHEMAS`.
- `cli-client/src/agent/tool-meta.ts` — add `check_jobs: { isConcurrencySafe: true, isReadOnly: true, abortsSiblingsOnError: false, defaultPermission: 'allow' }`.
- `cli-client/src/agent/executor.ts` —
  - Short-circuit `check_jobs` before the dispatch switch (mirroring the existing `reason` short-circuit). Calls `JobRegistry.list(runId)` or `JobRegistry.poll(jobId)`; returns the result directly without going through `dispatch()` or the server.
  - The `run_command` dispatch passes `runId` + a derived `label` (first 40 chars of command) into `runCommandTool` so the JobRegistry tags entries with the right run.

### CLI — status indicator

- `cli-client/src/cli/job-status.ts` *(new)* — `JobStatusBar` singleton. Maintains its own `ora` spinner pinned at the bottom while the main agent output streams above it. Updates every 1s with the current job state: `⟳ npm install (12s) · 1 more job`. On job completion: shows `✓ npm install (28s)` for 3s then disappears. On failure: shows `✖ npm install (5s) — exit 1` and stays until the next agent response (so the failure isn't easily missed). Uses `ora` (already a dep) plus a small interval timer; no new packages.
- `cli-client/src/agent/agent.ts` — wire `JobStatusBar.start()` once `JobRegistry` has any active jobs; `JobStatusBar.stop()` on terminal run-exit. The bar pauses (clears its line) when the main spinner needs the same row — they shouldn't fight.

### CLI — agent-loop integration

- `cli-client/src/agent/agent.ts` — on terminal run-exit, await `JobRegistry.cleanupRun(runId)` so the run doesn't return success until in-flight jobs either finish or get killed (with the 30s wait). Append a brief background-job summary to the run's usage log entry (`backgroundJobsRun: number, backgroundJobsFailed: number`).
- `cli-client/src/agent/usage-log.ts` — extend `RunSummary` with `backgroundJobsRun + backgroundJobsFailed`.

### Prompt updates (server-side)

- `server/src/providers/prompt/sections/tools.ts` — extend the `run_command` tool description:
  > Args: `{ "command": "...", "cwd": ".", "background"?: true }`
  > By default, INSTALL commands (`npm install`, `pnpm install`, etc.) run in the BACKGROUND. The tool returns `{ jobId, status: "running" }` immediately so you can keep working — read package.json, customise files, etc. Use `check_jobs` to poll status. Pass `background: false` if you need to read the install output (rare).
  >
  > New tool: `check_jobs` — args `{ "jobId"?: "..." }`. Without jobId, lists all jobs for the run with their current status. With jobId, returns just that job's state. Cheap; call after a few unrelated steps to check if the install has finished.
- `server/src/providers/prompt/sections/task-guidelines.ts` — extend the COMMANDS block:
  > After a scaffold, run `npm install` (it auto-backgrounds). Don't wait — start customising the project immediately. Call `check_jobs` after a few file edits to confirm install succeeded before suggesting `npm run dev` in the summary.

### Tests

- `cli-client/src/agent/__tests__/background-jobs.test.ts` *(new)* — JobRegistry behaviour:
  - `start` → `poll` returns `running`; after the spawned process exits the next poll returns `done` with `exitCode: 0`.
  - Per-run `MAX_CONCURRENT_PER_RUN = 3` cap throws on the 4th `start`.
  - `wait(jobId, 50ms)` on a 200ms-long process returns `{ status: 'running' }` and doesn't hang.
  - `cleanupRun` SIGTERMs leftover jobs after the wait timeout.
  - `list(runId)` returns running jobs first.
- `cli-client/src/agent/__tests__/run-command-background.test.ts` *(new)* — `runCommandTool` decision matrix:
  - `runCommandTool('npm install', '.')` → returns `{ startedBackground: true, jobId, status: 'running' }`.
  - `runCommandTool('npm install', '.', { background: false })` → falls back to the synchronous path.
  - `runCommandTool('npm test', '.')` → synchronous (not in BACKGROUND_BY_DEFAULT_PATTERNS).
  - `runCommandTool('npm run dev', '.')` → still refused (long-running).
  - `runCommandTool('cargo build', '.')` → backgrounds.
- Use a tiny shell sleeper (`node -e "setTimeout(() => process.exit(0), 100)"`) instead of real npm for hermeticity.

### Docs

- `docs/status/current.md` — Recent Work entry for Phase 7.

## Migrations / data

N/A. Background jobs are in-memory only. They die with the CLI process. Cross-run persistence is explicitly deferred (out of scope).

## Hooks / skills / settings to update

- New flag in `cli-client/src/agent/flags.ts`: `cli.background_jobs_enabled` (default `true`) — env-only kill switch in case the JobStatusBar interferes with a tricky terminal. Plus `cli.max_concurrent_background_jobs` (default `3`) and `cli.background_job_timeout_ms` (default `300_000`).

## Dependencies

- No new packages. `ora` and `child_process.spawn` are already deps.
- No env vars beyond the three flags above.

## Risks & mitigations

- **JobStatusBar fights with the main spinner for the bottom row** — both use `ora`. → JobStatusBar uses ANSI cursor positioning to render at a known row (terminal height − 1) instead of relying on `ora`'s default cursor handling. Falls back to a simple periodic console.log when the terminal isn't a TTY (CI, piped output).
- **Backgrounded install fails silently** because the agent never polls — task completes with deps missing. → On terminal run-exit, `cleanupRun` waits up to 30s and surfaces any failed background job in the run summary. Plus the prompt explicitly tells the agent to call `check_jobs` after a few steps. Plus the bottom status bar stays visible on failure until the next response so the user sees `✖ npm install (5s) — exit 1`.
- **Concurrent installs in the same dir corrupt node_modules** — agent triggers two `npm install` jobs in parallel. → `MAX_CONCURRENT_PER_RUN = 3` is generous; per-cwd uniqueness is NOT enforced because legitimate use cases (mono-repo with two packages) need it. The 3-cap covers the dumb-mistake case (8+ parallel).
- **5min per-job timeout isn't enough for a slow `cargo build` on a fresh project** — → Configurable via flag. If a user routinely needs more, they raise `cli.background_job_timeout_ms`. 5min is the safe default for npm-class installs.
- **Existing `SLOW_COMMAND_PATTERNS` skip is load-bearing for `npx prisma init`** — losing it would let the agent run destructive migrations. → Phase 7 ONLY removes npm/yarn/pnpm/bun install + pip install + bundle install + cargo build from the slow list. prisma / shadcn / tailwindcss stay skipped.
- **`check_jobs` becomes the agent's new infinite-poll antipattern** — agent calls it 50 times in a row instead of doing work. → Tool description tells the agent to call it AFTER a few unrelated steps. The audit log will show abuse if it happens; we can add a rate cap in a follow-up if needed.
- **JobStatusBar leaves stale cursor state if the CLI is killed mid-run (Ctrl+C)** — → Register a `process.on('SIGINT')` cleanup that resets the cursor + clears the bottom row before exit. Same handler runs on normal terminal exit.
- **Windows `child_process.spawn` shell quoting differs** — install commands with quoted args break. → Reuse the exact `cmd.exe /c <cmd>` vs `/bin/sh -c <cmd>` pattern from the existing `runCommandTool`. No new shell logic.
- **Tests need real subprocesses but should stay fast** — → Use a tiny `node -e "setTimeout(...)"` sleeper. Each test under 500ms.

## Implementation order

Each step compiles green and is independently revertable.

1. **JobRegistry** — `cli-client/src/agent/background-jobs.ts`. Pure (well, modulo `child_process.spawn`); no callers yet. Tests for start/poll/list/wait/cleanupRun + the 3-cap.
2. **runCommandTool background path** — carve install patterns out of `SLOW_COMMAND_PATTERNS`; add `BACKGROUND_BY_DEFAULT_PATTERNS`; extend signature with `opts.background + runId + label`; route to JobRegistry when warranted. Tests for the decision matrix.
3. **Schemas + meta** — extend `runCommandSchema` with `background?: boolean`; add `checkJobsSchema` + register in `TOOL_SCHEMAS` + `tool-meta.ts`.
4. **Executor short-circuit for `check_jobs`** — list/poll dispatch; never goes through `dispatch()` or the server.
5. **JobStatusBar** — `cli/job-status.ts` with cursor-positioned bottom row + 1s tick + start/stop/pause API. SIGINT cleanup.
6. **agent.ts wire-up** — start the bar when JobRegistry has jobs; stop on terminal exit; await `cleanupRun(runId)`; extend RunSummary.
7. **Prompt updates** — `tools.ts` description for `run_command` (background flag + `check_jobs` tool); `task-guidelines.ts` COMMANDS block.
8. **Flags + docs** — register the three flags; status doc Recent Work entry.

## Verification

- **Compile:** `tsc --noEmit` clean in both packages.
- **Tests:** `npm test` in `cli-client/` adds ~15 cases.
- **Manual smoke:**
  - In an empty dir: `sys "create a react app for a todo list"` → scaffold runs (Phase 6); the post-scaffold `npm install` triggers BACKGROUND mode automatically; the agent immediately starts customising App.tsx; bottom-of-screen shows `⟳ npm install (NNs)`; when install finishes, the bar shows `✓ npm install (32s)` for 3s then disappears.
  - Force foreground: agent sends `run_command({ command: "npm install", background: false })` → synchronous behaviour, no bar.
  - Failure path: `sys "create a react app"` then sabotage by pointing it at a write-protected dir → `✖ npm install (Ns) — exit N` stays visible; check_jobs returns `{ status: 'failed', exitCode: N, stderrTail: "..." }`.
  - Cap test: artificially trigger 4 backgrounds → 4th throws and the agent gets the error message.
- **Audit log spot-check:** `<sysbasePath>/audit-YYYY-MM-DD.jsonl` shows `tool: 'run_command'` AND `tool: 'check_jobs'` entries with category `null` (success).

## Follow-ups (out of scope this session)

- **Cross-run job persistence** — long-running jobs survive a CLI restart. Needs an on-disk job state file + reattachment logic.
- **Parallel job orchestration** — kick off 3 installs across 3 monorepo packages in parallel, surface aggregate progress.
- **Streaming stdout into the status bar** — show the last line of `npm install` output instead of just elapsed time.
- **Server-side mirror** — let the server know about background jobs so cross-device sessions can reattach. Big change; deferred.
- **Network-aware retries on install failure** — auto-retry once on flaky network errors before surfacing to the user.

## Completion notes

Implemented 2026-05-02. All 8 ordered steps executed in sequence and pushed as 7 separate feature/test/docs commits.

**Deviations from the plan:**

- The plan's "tool 13" check_jobs index in the prompt section ended up as **tool 14** because Phase 5 had already taken slot 13 for the `reason` tool. Indices renumbered.
- `JobStatusBar` ended up not registering its SIGINT handler until first start — defensive against importing the module without ever running the bar (e.g. in tests). Same outcome, cleaner.
- Pinned cursor positioning uses `process.stdout.rows ?? 24` as a fallback when the terminal doesn't expose its row count. On a default 24-line terminal the bar lives at row 24 which is usually below the agent's output; on bigger terminals it pins to the actual bottom row.
- The `forget(jobId)` API didn't get wired into the agent loop — it'd be useful for keeping the JobRegistry from accumulating done jobs across long sessions, but Phase 7 intentionally keeps them so check_jobs without a jobId still returns the full run history. Cleanup happens via `cleanupRun` on terminal exit.
- Tests use the existing `node` binary as a hermetic sleeper (`node -e "setTimeout(()=>process.exit(0), 100)"`) — no new test deps. Each test under 200ms.

**Surprises:**

- The existing `runCommandTool` had `npm install` in `SLOW_COMMAND_PATTERNS` for the auto-skip path — turning that into the auto-background path was a one-line move into the new `BACKGROUND_BY_DEFAULT_PATTERNS` list. Bigger fix than expected because it means the agent can now actually install deps, which it couldn't before.
- ANSI cursor positioning is finicky on some terminals (Windows Terminal works; legacy `cmd.exe` is patchier). The TTY-check fallback to `console.log` covers the worst cases. If a Windows-only user reports breakage, we add an env var to disable the bar entirely.
- Test isolation matters: `_resetForTests()` SIGTERMs every job in the registry between tests so a leaked sleeper from test A doesn't break test B's per-run cap.

**Knowledge to capture (next pass):**

- "Background jobs survive only the lifetime of the CLI process — for cross-run jobs we'd need on-disk state" → `.claude/knowledge/decisions.md`.
- "ANSI cursor positioning + falling back to console.log for non-TTY" → `.claude/knowledge/patterns.md`.
- "Per-run resource caps (background jobs / reasoning calls) keyed by runId so terminal exit cleans them all up" → `.claude/knowledge/patterns.md`.
