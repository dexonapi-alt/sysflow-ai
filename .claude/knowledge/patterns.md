# Patterns

Reusable code patterns confirmed across the codebase. Each entry describes the pattern, the call sites that use it, and the rule for adding the next instance.

## Investigation-before-write pattern

- **Source:** plan `applied/2026-05-13-command-first-investigation.md`

For any non-trivial implement / bug / explore task, the agent runs a short chain of read-only shell commands BEFORE issuing a `read_file` or `write_file` / `edit_file`. The chain is platform-aware and intent-driven. The platform branch is detected from `env-info.ts`; the intent comes from the preflight reasoner's `pipeline` field.

### Bug-hunt sequence (typical 3-5 commands)

```
git log -10 --oneline                 # what's the recent intent
git status                            # are there uncommitted changes that explain the symptom
grep -rn '<symbol-from-error>' src/   # where does the failing thing live
git diff HEAD~3 -- <suspect-file>     # what changed lately in the suspect area
```

PowerShell equivalents on Windows:

```
git log -10 --oneline
git status
Select-String -Pattern '<symbol>' -Path 'src/*' -Recurse
git diff HEAD~3 -- <suspect-file>
```

### Implement-in-unknown-codebase sequence

```
ls -la                                # what's at the root
cat package.json                      # stack + scripts + deps
git remote -v                         # context (mono vs many small)
find . -name '*.config.*' -not -path '*/node_modules/*'
ls src/                               # how is source organised
```

PowerShell:

```
Get-ChildItem -Force
Get-Content package.json
git remote -v
Get-ChildItem -Recurse -Filter '*.config.*' | Where-Object { $_.FullName -notmatch 'node_modules' }
Get-ChildItem src
```

### Explore/explain sequence

```
find . -name '*<topic>*'              # where does the topic live
grep -rn '<topic>' src/ | head -20    # how is it used
cat <best-candidate-from-grep>        # confirm before read_file
```

### Trivial-task short-circuit

For *"add a console.log to line 42 of server.ts"* or *"rename `getFoo` to `fetchFoo`"*: SKIP the investigation chain entirely. The LLM is instructed to gauge depth via `DEEP_REASONING_PROMPT`'s depth-awareness clause; the system safety net is `getInvestigationBudget(complexity === "simple") = 1`. *"Manufacturing investigation where none is needed"* is the failure mode this branch exists to prevent.

### Composition with the preflight `investigationPlan`

Stage 3 of the plan added an optional `investigationPlan: Array<{ command, expectedSignal, pivotIf? }>` field on `implementBrief` + `bugBrief`. When the reasoner populates it, those commands ARE the first iteration of the chain above. The renderer (`reasoning-brief.ts`) emits them as a `═══ INVESTIGATE FIRST ═══` block with confidence-aware framing:

- HIGH confidence → `MUST run these before writing`
- MEDIUM → `Run these; deviate only if a result invalidates the assumption`
- LOW → `Suggested commands; adapt freely as you learn`

The agent extends the chain past the brief's plan when results suggest a pivot — `pivotIf` is hint not handcuff.

### Where this pattern shows up in code

- Prompt section: `server/src/providers/prompt/sections/investigation.ts` (platform-aware command examples)
- Brief field: `server/src/reasoning/reasoning-schema.ts: investigationPlan`
- Brief renderer: `server/src/providers/prompt/sections/reasoning-brief.ts` (`═══ INVESTIGATE FIRST ═══` block)
- Safe-command allowlist (auto-approval): `cli-client/src/agent/safe-commands.ts: isSafeReadOnlyCommand`
- Budget cap: `server/src/services/free-tier-policy.ts: getInvestigationBudget`
- Telemetry: `cli-client/src/agent/usage-log.ts: RunSummary.investigationCommandsCount`

### Rule for adding the next instance

When a new task intent (e.g. *refactor*, *audit*, *migrate*) needs its own investigation shape:

1. Add a sub-section to `prompt/sections/investigation.ts` describing the canonical command sequence — start with project-shape probes (`ls`, `git remote -v`, etc.), then drill via `find` / `grep` to the relevant files, then `cat` (or `Get-Content`) the top 1-2 candidates.
2. Add the safe commands to the regex whitelist in `safe-commands.ts` if they're not already covered.
3. If the intent maps to a new pipeline kind, add an `investigationPlan` example to the pipeline's prompt in `server/src/reasoning/pipelines/`.
4. Add a row to `getInvestigationBudget` only if the budget should differ from the default for that intent.

The pattern is platform-aware by default; document both bash and PowerShell variants whenever shell command examples appear in prompts or docs.
