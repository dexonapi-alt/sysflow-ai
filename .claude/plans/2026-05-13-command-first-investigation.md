# Command-first investigation: shell as the primary context-gathering interface

- **Created:** 2026-05-13
- **Status:** draft
- **Scope:** Shift the agent's default mode of context-gathering from `read_file` to `run_command`. Mirror Claude Code's behaviour: investigate the system end-to-end with shell commands first, reason about each result before the next command, and only read files when about to edit them. Add a safe-command allowlist so read-only investigation doesn't drown the user in permission prompts. Extend reasoning briefs with an `investigationPlan` so the preflight Flash call decides which commands to run. Add a divergence heuristic that catches "wrote files without exploring first." Compose cleanly with the model-lock-and-portable-reasoning plan that lands first.

## Goal

The user's symptom: *"our AI only reads when asked to read the file, it doesn't have a free exploration on its own"* — and the contrast with Claude Code: *"claude code doesn't just read files, it uses command line heavily with reasoning thats why claude code is accurate because it not just uses read to get context it get context heavily by running commands to investigate thoroughly with heavy strong reasoning, commands are necessary not just read files."*

Today's behaviour, confirmed in code:
- `tools.ts` (prompt section) tells the model `run_command` is for *"scaffolders, npm install, build commands, test commands, git, one-shot scripts"* — implicitly framing commands as side-effectful, not investigative.
- `task-guidelines.ts` prescribes *"batched `read_file` for exploration"* as the default first move.
- `reasoning-schema.ts` has no `recommendedCommands` / `investigationPlan` / `commandsToRun` field on any pipeline brief. The reasoner produces *what to build*, never *what to run to understand first*.
- `permissions.ts` + `tool-meta.ts` treat every `run_command` as `ask` regardless of whether the command is `git status` or `rm -rf /`. So even when the model wants to investigate via shell, the user is buried in approval prompts.
- `divergence-detector.ts` has six heuristics — same-file-churn, repeated-tool-error, intent-keyword-absent, scope-creep, mkdir-empty, completion-claims-unwritten — but none model "investigated-before-writing."

After this plan: each iteration in `implement` / `bug` runs has command + reasoning + result-driven next-step until the agent has built ground-truth understanding of the system. Files are *read only when about to be edited*. The agent runs `git status`, `git log -10 --oneline`, `ls`, `find . -name '*.ts' | head`, `grep -r symbol src/`, `npm list pkg`, `which node`, `cat package.json | head` (or PowerShell equivalents on Windows) — chained by reasoning — before any `write_file`. Free-tier budgets cap runaway investigation; the divergence detector flags "no investigation before writing" as a low-confidence signal.

## Context from knowledge base

- `architecture.md: ## Chunked reasoning loop (Phase 10)` — chunk planner currently decides which **files** to write per chunk. After this plan it also decides which **commands** to run before writing them.
- `architecture.md: ## Awareness + recovery (Phase 11)` — the six existing divergence heuristics in `divergence-detector.ts`. This plan adds a seventh: `no_investigation_before_write`. Composes additively, doesn't replace any existing heuristic.
- `decisions.md: ## Chain WITHIN a concern, peer ACROSS concerns` — informs the design choice: investigation is a *concern within preflight*, not a separate top-level phase. We extend the existing implement / bug pipelines, not add a new "investigation pipeline."
- `gotchas.md: ## run_command on Windows uses PowerShell, not bash` — already captured in code (`tools.ts:749,879` branches on `process.platform === "win32"`), but the model's prompt is platform-agnostic today. This plan threads platform-aware command examples into the system prompt's investigation section.
- `applied/2026-05-06-phase-11-awareness-and-recovery.md` — Phase 11's verification-gate pattern: ground-truth checks parallel to LLM-backed checks. This plan reuses that pattern — the safe-command allowlist is a ground-truth gate (regex match against a whitelist), the divergence heuristic is the LLM-adjacent layer.
- `applied/2026-05-07-phase-16-deep-reasoning-on-free-models.md` — `free-tier-policy.ts` is the central module for tier-aware caps. This plan adds `getInvestigationBudget(model, intent, complexity)` to the same module.
- Composes with **`2026-05-07-model-lock-and-portable-reasoning.md` (draft, not yet applied)** — that plan strengthens brief framing and adds the pluggable reasoner backend. This plan extends the brief *content* (new `investigationPlan` field) under that strengthened framing. **Apply the model-lock plan FIRST, then this one** — otherwise the new investigation directive lands with the soft-framing trailer and the model glances at it.

## Affected files

**Stage 1 — System prompt: investigation-first directive**

- `server/src/providers/prompt/sections/tools.ts` — rewrite the `run_command` description (currently lines ~30–32) from "use for scaffolders / install / build" to *"PRIMARY context-gathering tool. Use to investigate the system end-to-end before reading or writing anything. Read-only commands (`git status`, `ls`, `grep`, `find`, `npm list`, `which`) require no approval and are your default first move on any non-trivial task. Use `read_file` ONLY when you have identified a specific file you need to edit."*
- `server/src/providers/prompt/sections/task-guidelines.ts` — replace the current "batched `read_file` for exploration" guidance with **investigate-then-read**: *"On any non-trivial task, your FIRST turn must be a `run_command` (investigation), not a `read_file`. Build your mental model from command output. After 2–4 investigation commands, you may switch to targeted `read_file` for files you've identified as relevant. Each command's `reasoning` field MUST state (a) what hypothesis it tests, (b) what you'll do with the result."*
- New section file: `server/src/providers/prompt/sections/investigation.ts` — concrete platform-aware investigation patterns. Three sub-blocks:
  - **Bug investigation** — start with `git log -10 --oneline`, `git status`, then `grep -r <symptom>` or platform PowerShell equivalent.
  - **Implement (unknown codebase)** — start with `ls`, `cat package.json` (or `Get-Content`), `git remote -v`, `find . -name "*.config.*"`.
  - **Explore / explain** — chain `find` + `grep` to map the topic; only `read_file` once you've narrowed to ≤ 3 candidates.
- `server/src/providers/prompt/build.ts` — register the new section. Priority slightly above `task-guidelines.ts` so investigation rules bind before task patterns.
- `server/src/providers/prompt/sections/env-info.ts` — already emits OS/shell; add a `PREFERRED_INVESTIGATION_COMMANDS` line that adapts: bash list on Unix, PowerShell list on Windows. So the model sees concrete platform-correct examples.

**Stage 2 — Safe-command allowlist**

- New file: `cli-client/src/agent/safe-commands.ts` — pure module exporting `isSafeReadOnlyCommand(cmd: string): boolean`. Regex-based whitelist covering the canonical investigation set: `git status|log|diff|branch|remote|show`, `ls|dir`, `find`, `grep|rg|Select-String`, `cat|type|head|tail|Get-Content`, `which|where`, `whoami|pwd|Get-Location`, `npm list|outdated|ls`, `node -v|--version`, `python -V|--version`, `cargo metadata|tree`, `pip list|show`, `tree`, `wc|Measure-Object`, `du|Get-ChildItem -Recurse | Measure-Object`, `Test-Path`, `Get-Command`. Deny anything with pipe-to-write, redirect-to-file, `&&`/`||`/`;` chaining a write, `rm|del|Remove-Item`, `mv|move|Move-Item`, `cp -r|copy|Copy-Item`, `npm install|npm i`, `git push|commit|reset|checkout|merge`, `curl -X|-o|-O`, `sudo`, `chmod|icacls`, `pwsh -c|powershell -c` invoking write commands. The matcher is conservative — when in doubt, NOT safe; the existing ask-gate handles unknowns.
- `cli-client/src/agent/permissions.ts` — extend the auto/default-mode logic at lines ~68–70 to consult `isSafeReadOnlyCommand` BEFORE returning `ask`. If safe, return `allow` and log `[permissions] safe-command auto-approved: <cmd>`.
- `cli-client/src/agent/__tests__/safe-commands.test.ts` — table-driven tests covering: safe Unix commands → true, safe PowerShell commands → true, write commands → false, chained write commands → false, suspicious patterns (backticks, command substitution wrapping a write) → false.
- `cli-client/src/lib/sysbase.ts` — new setting `commands.auto_approve_safe` (default `true`). Users who want to see every command can flip it to `false`.

**Stage 3 — Reasoning brief: investigation plan**

- `server/src/reasoning/reasoning-schema.ts` — extend `implementBrief` (lines 52–73) and `bugBrief` (lines 77–100) with a new optional field:
  ```ts
  investigationPlan: z.array(z.object({
    command: z.string().min(1),
    expectedSignal: z.string().min(1),   // "what we expect this command to reveal"
    pivotIf: z.string().optional(),       // "what next command to run if the signal differs"
  })).max(6).default([])
  ```
  Optional + max 6 so Flash doesn't over-prescribe; the model can still investigate beyond the brief's plan.
- `server/src/reasoning/pipelines/implement.ts` + `bug.ts` (pipeline system prompts) — extend the system prompt to ask Flash for `investigationPlan` BEFORE the buildPlan / fix. Frame it as *"List the 3-5 commands the agent should run to verify your assumptions before writing or editing. Each entry: command, expectedSignal, pivotIf."*
- `server/src/providers/prompt/sections/reasoning-brief.ts` — render the new field as a directive block, mirroring the existing CHUNK PLAN style (the only brief block today that uses hard framing):
  ```
  ═══ INVESTIGATE FIRST (run these before writing) ═══
  1. <command>  → expect: <signal>  (if not: <pivot>)
  2. ...
  After running these and reasoning about results, proceed to BUILD PLAN.
  ═══ END INVESTIGATE FIRST ═══
  ```
  Confidence-aware (composes with the model-lock plan's framing change): HIGH-confidence briefs render as MUST-run; LOW-confidence renders as "suggested commands, adapt freely."
- `server/src/reasoning/repair.ts` — add `investigationPlan: []` default to the per-pipeline repair functions so old Flash responses (without the field) don't fail Zod (`min(1)` was the production bug repair currently handles).
- `server/src/reasoning/__tests__/repair.test.ts` — add cases: `investigationPlan` missing → repaired to `[]`; entries with empty command strings → filtered out.

**Stage 4 — Handler tracking + Phase-11 awareness**

- `server/src/services/run-state.ts` (or wherever per-run counters live — check `chunk-state.ts` first; the counter likely belongs there) — track `investigationCommandCount` and `firstWriteOrEditTurn` per runId.
- `server/src/handlers/tool-result.ts` — after each tool result, increment the counter when the tool was `run_command` AND `isSafeReadOnlyCommand(args.command)` is true. Stamp `firstWriteOrEditTurn` on the first `write_file` / `edit_file` / `batch_write`.
- `server/src/awareness/divergence-detector.ts` — add seventh heuristic `no_investigation_before_write`: fires when `firstWriteOrEditTurn` is set AND `investigationCommandCount` at that turn was 0 AND `intent !== "trivial"`. Confidence delta: −15 (mild — investigation is preferred, not required for every task; some prompts like "add a button to App.tsx" don't need exploration).
- `server/src/awareness/__tests__/divergence-detector.test.ts` — table tests covering the new heuristic across intent / complexity combinations.
- `cli-client/src/ui/components/ReasoningPeek.tsx` — surface the `investigationPlan` in the peek so the user sees what the agent's about to investigate, building trust that exploration is happening on purpose.

**Stage 5 — Free-tier policy + telemetry + knowledge entries**

- `server/src/services/free-tier-policy.ts` — new pure helper `getInvestigationBudget(model, intent, complexity)` returning a per-turn cap on `run_command` calls. Free tier: 4 / turn for `implement` medium-complexity, 6 / turn for `bug`. Paid: 10 / turn. Beyond budget: handler injects a `[BUDGET]` reminder in the tool-result asking the model to switch from investigation to action.
- `cli-client/src/agent/usage-log.ts` — extend `RunSummary` with `investigationCommandsCount` so telemetry shows the new behaviour at a glance.
- `.claude/knowledge/architecture.md` — append `## Command-first investigation` under the existing Phase-11 awareness section. Distill the loop: command → reasoning → result → next command → ... → first write.
- `.claude/knowledge/decisions.md` — append `## Why investigate via commands, not file reads` (the rationale: commands return short factual output the model can reason about; reads return long files the model skims and hallucinates against).
- `.claude/knowledge/patterns.md` — append `## Investigation-before-write pattern` (concrete command sequences for bug / implement / explore intents, platform-aware).
- `.claude/knowledge/gotchas.md` — append `## Read-only commands used to require approval per call` (the bug this plan fixed, so it doesn't regress).

## Migrations / data

N/A — no schema migrations, no persistent state changes. The `investigationCommandsCount` and `firstWriteOrEditTurn` are per-run in-memory; existing chunk-state.ts owns the same lifetime.

## Hooks / skills / settings to update

- `cli-client/src/lib/sysbase.ts`: new setting `commands.auto_approve_safe` (bool, default `true`).
- `server/src/services/flags.ts`: register `awareness.no_investigation_heuristic_enabled` (bool, default `true`) so the new heuristic can be disabled without code change if it over-fires.
- `server/src/services/flags.ts`: register `reasoning.investigation_plan_enabled` (bool, default `true`) so the brief extension can be disabled if Flash starts producing junk command lists.
- No `.claude/hooks/` changes.
- No skill changes.

## Dependencies

- No new packages.
- No new env vars.
- No external services.

## Risks & mitigations

- **Risk:** Model runs 15 investigation commands when 3 would suffice → cost explosion on free tier. **Mitigation:** `getInvestigationBudget` caps per-turn count; over-budget reminder in tool-result asks the model to act. Divergence heuristic `scope_creep` already catches "too many turns" if the budget cap is bypassed.
- **Risk:** Safe-command allowlist accidentally allows a destructive command (regex false-positive). **Mitigation:** Whitelist is *additive* (default to ask), conservative on chained / piped / sub-shelled commands. Each release of the allowlist adds tests for the new patterns. Users keep the `bypass`/`auto`/`plan`/`default` mode switches as the broader gate.
- **Risk:** Investigation slows iteration when the task is trivial ("add a button to App.tsx"). **Mitigation:** Heuristic fires `no_investigation_before_write` only when `intent !== "trivial"` AND complexity is medium+. Brief's `investigationPlan` is optional; trivial-intent briefs leave it empty so no directive renders.
- **Risk:** Platform-aware commands fragment guidance — Windows vs Unix. **Mitigation:** `env-info.ts` already detects platform; the new investigation section reads that signal and shows the correct command examples. Patterns file documents both.
- **Risk:** The new heuristic over-fires on legitimate "user pasted code, asked me to add a feature" turns. **Mitigation:** Confidence delta is mild (−15). One miss won't trigger the off-course modal (threshold is 60). User can disable the heuristic via flag.
- **Risk:** Flash hallucinates wrong commands in `investigationPlan` (e.g., bash on Windows). **Mitigation:** Pipeline prompts include the platform signal so Flash gets the same env-info the main model gets. Repair pass filters empty / malformed entries. Worst case: user sees a permission prompt for a slightly-wrong command and denies it — no breakage.
- **Risk:** Composes badly with `2026-05-07-model-lock-and-portable-reasoning` (still draft, not applied). **Mitigation:** Apply the model-lock plan FIRST. This plan's `reasoning-brief.ts` changes assume the framing-strength rewrite is in. If they land out of order, the new INVESTIGATE FIRST block lands with soft framing and the model glances at it.

## Implementation order

1. **Stage 1 — System prompt directive shift.** Highest impact, smallest blast radius (prompt-only). Land first so the model starts running commands; the rest of the stages strengthen + measure the behaviour.
2. **Stage 2 — Safe-command allowlist.** Without this, Stage 1 floods the user with permission prompts. Lands right after to make the new behaviour usable.
3. **Stage 3 — Reasoning brief: `investigationPlan`.** Now that the model runs commands, give it a Flash-suggested starting list. The reasoner already knows the user's intent; surfacing a 3–5 command plan reduces "what should I run first?" hesitation.
4. **Stage 4 — Handler tracking + divergence heuristic.** Now we can observe whether the new behaviour is sticking. The heuristic catches regressions; the tracking feeds telemetry.
5. **Stage 5 — Free-tier policy + telemetry + knowledge entries.** Budget caps land last (so we have telemetry to tune them); knowledge entries last (distill what shipped).

Each stage = one PR off `main`. Stage labels: `feat(prompts): Stage 1 — investigate-first directive`, etc.

## Verification

**Stage 1**
- Unit: snapshot test of `tools.ts` + `task-guidelines.ts` rendered sections — both contain the new directive language; `tools.ts` mentions `read_file` only under "use when about to edit."
- Manual: run a bug-fix task ("fix the broken import in components/Foo.tsx") — observe the agent's first action is a `run_command` (e.g., `git status` or `grep -r 'Foo'`), not a `read_file`.

**Stage 2**
- Unit: `isSafeReadOnlyCommand` table — 30+ positive cases (every command in the whitelist), 20+ negative cases (write variants, chained writes, sub-shell injection).
- Manual: run a session, observe `git status` / `ls` / `grep` auto-approved with `[permissions] safe-command auto-approved` log lines; npm install still prompts.
- Setting toggle: flip `commands.auto_approve_safe = false`, observe every command prompts again.

**Stage 3**
- Unit: Flash mock returns a brief with `investigationPlan: [{ command: "git status", expectedSignal: "...", pivotIf: "..." }]` — repair preserves it, prompt section renders it as `═══ INVESTIGATE FIRST ═══`.
- Unit: brief without `investigationPlan` field repairs to `[]` and the prompt section omits the block entirely.
- Manual: run an `implement` task; observe `<ReasoningPeek>` shows the investigation plan; the main model runs commands matching the plan.

**Stage 4**
- Unit: divergence-detector table — `no_investigation_before_write` fires when expected; doesn't fire on trivial-intent runs.
- Telemetry: `investigationCommandsCount` populates per run; trend over 10 runs should show ≥ 2 for non-trivial tasks.
- Manual: deliberately do a trivial task ("add a logging line to server.ts") — heuristic stays silent. Then a complex task without auto-investigation — confidence drops by 15.

**Stage 5**
- Unit: `getInvestigationBudget` table — every (model, intent, complexity) tuple returns the documented cap.
- Manual: free-tier model + medium-complexity task with `investigationCommandsCount=4` AT BUDGET → no reminder; at 5 → tool-result includes `[BUDGET] you've used the investigation budget for this turn — switch to action.`
- All knowledge entries lint via `memex-md add` (no markdown errors, anchors land correctly).
- `npm test` clean; `npm run typecheck` clean.

## Out of scope

- **Auto-classifying every command via LLM** — we use regex-based safe-command detection, not a per-command LLM judgement call. LLM-judged safety is a future enhancement only if regex false-positives become a real pain.
- **Reorganising the existing tool list to deprecate `read_file`** — `read_file` stays as a peer tool; we only shift the prompt-level default. Removing a tool would break the broader agent surface.
- **Adding `run_command` background-mode investigation patterns** — investigation commands are foreground/short by definition. Background commands stay for build/test/server-start workflows.
- **Multi-turn investigation orchestration via a separate "investigator agent"** — single-agent loop is enough; the reasoning brief + divergence heuristic give us the discipline without splitting agents.
- **Cross-session investigation memory** — each run's investigation is fresh. If a future "what did I learn last time" feature wants to persist, that's Phase 12-style continuation territory.
- **Replacing the Phase-10 chunk planner's file list with a command-and-file list** — chunk plan stays file-focused. Investigation commands sit in the preflight brief (Stage 3), not in the chunk plan.
