# Awareness heuristics + verification correctness

- **Created:** 2026-05-16
- **Status:** draft
- **Scope:** Fix the false-positives + missing-halts in the existing awareness layer that surfaced once the prior runtime-fixes plan shipped. (a) Stage 4's per-turn directory refresh false-flagged `.env.example` as stale because of an overly aggressive dotfile filter. (b) `intent_keyword_absent` over-fires by matching against file PATHS only, so a legitimate POS-PG backend without "POS" / "postgres" in filenames triggers `state=blocked`. (c) When awareness DOES reach `blocked`, the modal that should halt the agent doesn't actually fire. (d) Windows `ls -la` reports `✔ success` even when PowerShell internal errors emit on stderr.

## Goal

User report (2026-05-16) — four narrow bugs in the awareness / verification layer:

1. `[directory-refresh] 1 stale top-level file(s): .env.example` — fired on a file that had JUST been created in the same turn. Root: `captureTopLevelTree` in `cli-client/src/agent/executor.ts` filters `e.name.startsWith(".")`. `.env.example` is a dotfile → filtered out → never reaches the server → server compares working context (which DOES track it) vs received tree (which doesn't) → flags stale. **My Stage 4 bug from the prior plan.**

2. `[awareness] per-step: 1 signal(s), confidence=75 state=on_track (categories: intent_keyword_absent)` → confidence dropped 75 → 50 → 25 over three turns. The agent IS building exactly what the prompt asked (Express + PostgreSQL POS backend); the heuristic matches the prompt's keywords ("express", "POS", "postgres") against file PATHS only, not against file CONTENT. So `package.json` (which has `express` in dependencies) and `src/config/db.ts` (which has `pg` in its imports) never count — the keyword absence is a false positive.

3. `state=blocked` (confidence=25) reached in the server logs but the agent kept executing. The off-course modal should have halted the chunk loop and asked the user for direction. Either the modal didn't render in this run, OR the synthesised `waiting_for_user` response wasn't honoured by the cli's loop.

4. `ls -la` on Windows:
   ```
   ● Bash(ls -la)
   ─ + FullyQualifiedErrorId : NamedParameterNotFound,Microsoft.PowerShell.Commands.GetChildItemCommand
   ✔ ls -la
   ```
   PowerShell aliases `ls` → `Get-ChildItem`, which rejects `-la` (Unix flag) with a non-terminating error. `$LASTEXITCODE` stays 0 (PowerShell internal error, not a native process). The cli treats code=0 as success and reports `✔`. User sees both the error AND success — bad signal.

End state:

- `.env.example` + `.eslintrc.json` + `.gitignore` + `.npmrc` no longer false-positive stale.
- `intent_keyword_absent` searches file CONTENT (cheap grep across newly-written files) before flagging a keyword absent — so a `package.json` with `"express"` in dependencies satisfies the "express" keyword.
- `state=blocked` actually halts the agent. The modal fires. The user picks continue / backtrack / redirect.
- Windows `ls -la` either gets mapped to `Get-ChildItem -Force` OR the cli surfaces stderr correctly when PowerShell internal errors occur, even with exit code 0.

## Context from knowledge base

- `architecture.md: ## Awareness loop (Phase 11)` — established the divergence detector + per-step confidence tracker + off-course modal.
- `architecture.md: ## Forced error reasoning + recovery` — INJECT/REJECT template informs Stage 3's modal-halt enforcement.
- `decisions.md: ## System-level enforcement beats prompt-level guidance for free models` — informs Stage 3 (modal must actually halt, not be a polite suggestion).
- `gotchas.md: ## run_command on Windows hit cmd.exe, breaking every bash-form alias the LLM emits` — PR #87 fix; Stage 4 of this plan is the extension when PowerShell itself errors internally.
- `applied/2026-05-15-agent-runtime-fixes-and-project-init-reasoning.md` Stage 4 — the dotfile-filter bug originates there.

## Affected files

### Stage 1 — Fix the dotfile filter in `captureTopLevelTree`

- `cli-client/src/agent/executor.ts: captureTopLevelTree` — current filter:
  ```ts
  .filter((e) => !e.name.startsWith(".") && e.name !== "node_modules" && !e.name.startsWith("sysbase"))
  ```
- Replace with a CONSERVATIVE filter that excludes only known-noise dotfiles + heavy dirs, NOT all dotfiles:
  ```ts
  const NOISE_TOP_LEVEL = new Set([".git", ".DS_Store", ".vscode", ".idea", "node_modules", "__pycache__", ".pytest_cache", ".mypy_cache", ".next", ".nuxt", "dist", "build", ".turbo", ".cache"])
  .filter((e) => !NOISE_TOP_LEVEL.has(e.name) && !e.name.startsWith("sysbase"))
  ```
- This keeps `.env`, `.env.example`, `.env.local`, `.eslintrc.json`, `.gitignore`, `.npmrc`, `.prettierrc`, `.editorconfig`, `.nvmrc`, `.dockerignore` — all legitimate top-level files the agent commonly authors + the user expects to see in the tree.
- Server-side `context-manager.ts: ingestDirectoryTree` should apply the SAME filter consistently so both sides agree on "top-level files worth tracking".
- 8 new tests for the filter (each known-noise excluded; each common dotfile preserved; cross-platform path semantics).

### Stage 2 — `intent_keyword_absent` searches file content, not just paths

- `server/src/services/divergence-detector.ts` (or wherever `intent_keyword_absent` lives — `extractIntentKeywords` + `haystackContains`).
- Current behaviour: extracts keywords from the prompt; checks whether they appear in the file paths / completion message.
- Fix: extend the haystack to include the **content** of newly-written files this run (already in the working context's `files` map's `summary` field for some tools, but the summary truncates).
- Better: maintain a per-run `contentSnippetIndex: Map<filePath, firstK_chars>` populated by `ingestToolResult`. Truncate to first 1KB per file (or first 50 lines) to keep memory bounded. The detector searches this index.
- Whitelist: certain keywords are auto-satisfied by structural signals:
  - `"express"` satisfied if `package.json` includes `"express"` as a dep.
  - `"postgres"` / `"postgresql"` / `"pg"` satisfied if `package.json` includes `pg` / `postgres` / `node-postgres`.
  - `"react"` satisfied if `package.json` has `react`.
  - `"prisma"` satisfied if `prisma/schema.prisma` exists.
- 8 new tests covering: keyword present in content matches; in package.json matches; missing → flagged; structural signals override; multi-keyword AND semantics.

### Stage 3 — `state=blocked` actually halts + surfaces modal

- Investigate the path from the awareness detector → handler synthesis → cli render. The investigation report Round 2 found: handler at `tool-result.ts:1021` synthesises `waiting_for_user` with `awarenessChoice=true` when blocked. Cli should receive this and render the off-course modal.
- Add a Zod-validated test for the response: when synthesised, `status: "waiting_for_user"` + `awarenessChoice: true` + non-empty `pendingAction` with options [continue / backtrack / redirect].
- `cli-client/src/agent/agent.ts` — verify the response handler at the `waiting_for_user` branch renders the modal. If `awarenessChoice` is missing or the modal is gated by an Ink-only path, fix.
- Add an end-to-end test: synthetic agent that produces a confidence-25 awareness → assert the cli's state machine halts after rendering the modal.
- 6 new tests + 1 integration test.

### Stage 4 — Windows `ls -la` exit-code semantics

- `cli-client/src/agent/shell.ts` — currently `args: ["-NoProfile", "-Command", <command> ; exit $LASTEXITCODE]`.
- Two-pronged fix:
  - **Preprocessing**: when the command contains a Unix-style alias known to break under PowerShell (`ls -la` / `ls -al` / `grep -r` / `cat -n`), map it to the PowerShell equivalent BEFORE dispatch. E.g. `ls -la` → `Get-ChildItem -Force | Format-Table -AutoSize`. Keep the original command in the result envelope's `originalCommand` field for the agent's reasoning.
  - **Stderr inspection**: even after preprocessing, if the command's stderr is non-empty AND contains PowerShell error markers (`FullyQualifiedErrorId`, `ErrorRecord`, `ParameterNotFound`), treat as failure regardless of exit code. The cli's tool-result reports `success: false` + error string.
- 10 new tests covering: each common Unix alias mapped; stderr-only PowerShell error caught; legitimate stderr (e.g. tsc warnings on stderr but exit 0) not over-classified.

### Stage 5 — Telemetry + KB + plan archive

- `cli-client/src/agent/usage-log.ts` — `RunSummary` gains:
  - `dotfileFilterCorrections: number` (per-run count of dotfiles preserved by Stage 1's fix that the old filter would have dropped — diagnostic that Stage 1 is doing something useful)
  - `intentKeywordContentMatches: number` (per-run count of intent keywords satisfied via file CONTENT — diagnostic that Stage 2's broader haystack is working)
  - `awarenessModalShown: boolean` (true if Stage 3's blocked-state modal actually rendered this run)
  - `windowsShellErrorsCaught: number` (Stage 4 stderr-classified failures)
- KB:
  - `architecture.md: ## Awareness loop` — extend with the content-based haystack rule (Stage 2).
  - `decisions.md: ## intent_keyword_absent searches content + structural signals` — rationale.
  - `decisions.md: ## Top-level directory snapshot keeps dotfiles, drops .git + heavy build dirs` — rationale.
  - `gotchas.md: ## .env.example flagged stale immediately after creation (Stage 4 dotfile filter)` — the regression repro.
  - `gotchas.md: ## Windows ls -la reports success despite PowerShell internal error` — PR #87 follow-up.
- Plan archived to `applied/`.

## Migrations / data

None.

## Hooks / skills / settings to update

- `quality.dotfile_filter_conservative` (bool, default `true`) — Stage 1 kill switch (reverting to all-dotfiles-stripped if telemetry shows surprises).
- `quality.intent_keyword_content_search_enabled` (bool, default `true`) — Stage 2 kill switch.
- `quality.windows_shell_unix_alias_remap` (bool, default `true`) — Stage 4 preprocessing toggle.

## Dependencies

- No new packages.

## Risks & mitigations

- **Conservative dotfile filter exposes dotfiles to the agent the prior filter hid.** Mitigation: the agent SHOULD know about `.env.example` / `.gitignore` — those are real top-level files. Surprise-quotient is low. Telemetry on `dotfileFilterCorrections` confirms.
- **`intent_keyword_content_search` is expensive on large repos.** Mitigation: search ONLY newly-written files this run (the contentSnippetIndex), capped at 1KB per file. Existing-large repos cap content scan via the project-init brief (which already knows file count).
- **Stage 3's blocked-state modal halts the agent unexpectedly when intent_keyword_absent over-fires.** Mitigation: Stage 2 reduces over-fire first; Stage 3 only catches what's left. Combined, the modal should be rare (high signal).
- **Windows shell alias remap rewrites commands the user wanted verbatim (debugging case).** Mitigation: the result envelope preserves `originalCommand` so the agent sees what was asked vs what ran. The agent learns to phrase native-PowerShell commands directly.
- **Stage 4's stderr inspection mis-classifies legitimate stderr-going tools (tsc/eslint print warnings to stderr).** Mitigation: detection patterns are specific to PowerShell error markers (`FullyQualifiedErrorId`, `ErrorRecord`). tsc warnings don't include those.

## Implementation order

1. **Stage 1 — Dotfile filter fix.** Trivial; clears the false-positive that pollutes Stage 4 telemetry. *(One PR.)*
2. **Stage 4 — Windows shell exit-code fix.** Independent; user-visible. *(One PR.)*
3. **Stage 2 — intent_keyword_absent content search.** Bigger change; touches divergence-detector + context-manager. *(One PR.)*
4. **Stage 3 — Blocked state halt + modal.** Requires Stage 2 to land first so the modal isn't over-fired. *(One PR.)*
5. **Stage 5 — Telemetry + KB + plan archive.** *(One PR.)*

Each stage = one PR off `main`. ~900 LOC + 32-36 new tests across five stages.

## Verification

**Stage 1**

- Unit: filter excludes each known-noise entry; preserves each common dotfile.
- Manual: re-run a fresh scaffold that authors `.env.example` — observe no `[directory-refresh] stale top-level files` warning.

**Stage 2**

- Unit: keyword in file content satisfies; in package.json dep satisfies; structural signals override; missing → flagged.
- Manual: build a POS PG backend (the user's repro) — observe no `intent_keyword_absent` signal once `package.json` has `express` + `pg`.

**Stage 3**

- Unit: confidence ≤ 30 + state=blocked synthesises waiting_for_user with awarenessChoice; cli render halts and shows modal.
- Manual: force a blocked state (test harness) — observe modal renders + agent halts.

**Stage 4**

- Unit: each Unix alias mapped; stderr-only PowerShell error caught; legitimate stderr preserved.
- Manual: run `ls -la` on Windows — observe `Get-ChildItem -Force` output OR a clear failure message; no false `✔`.

**Stage 5**

- Telemetry populates. KB entries lint clean.

## Out of scope

- **Recursive directory snapshot.** Stage 1 stays top-level (depth 1) per the prior plan's "out of scope" notes.
- **Replacing the awareness heuristic engine.** Stage 2 fixes one heuristic (`intent_keyword_absent`); the others (`same_file_edited_repeatedly`, `repeated_tool_error`, etc.) stay as-is.
- **Cross-shell aliasing for bash / zsh on macOS / Linux.** Stage 4 targets Windows specifically — Unix shells handle `ls -la` natively.
- **Off-course modal UX overhaul.** Stage 3 only ensures the existing modal halts properly; visual redesign deferred.

## Composition with existing systems

- **Agent-runtime-fixes plan** (applied 2026-05-15) — this plan's Stage 1 is a follow-up patch to that plan's Stage 4.
- **Reasoning-chain provider parity plan** — Stage 3's modal halt depends on the cli's `waiting_for_user` render path which is unchanged.
- **Accountability plan** — Stage 1 batch caps reduce the rate of awareness false-positives (fewer simultaneous unrelated changes per turn = less likely to confuse the keyword detector).
