# Gotchas

Past bugs and non-obvious constraints worth preserving so the next contributor doesn't re-discover them.

## Reasoning cache key was prefix-truncated → chunk plans aliased

- **Source:** plan `applied/2026-05-06-phase-10-chunked-reasoning-loop.md` (Stage 6)
- **Symptom:** in a long Phase 10 chunked run, the planner started returning a stale plan from a prior chunk.
- **Root cause:** `task-reasoner.ts: runReasoningInner` hashed the cache key over `JSON.stringify(payload.context).slice(0, 2000)`. Phase 10's chunk_plan / chunk_reflect contexts grow monotonically (chunkHistory + lastReflection), so two distinct chunks with shared 2 KB prefixes produced identical truncated strings → same sha256 → same cache hit. Wrong plan delivered.
- **Fix:** hash the FULL serialised context with sha256 before using as the cache key (`hashContext` helper in `task-reasoner.ts`). Identical contexts (e.g. retry of the same chunk) still hit; distinct contexts always miss.
- **Test guard:** `server/src/reasoning/__tests__/hash-context.test.ts` includes a regression case where two contexts share a 2050-char prefix.

## OpenAI-Harmony framing tokens broke JSON.parse

- **Source:** PR #9
- **Symptom:** runs against OpenRouter `auto` (which routes to gpt-oss variants) failed with *"Model returned malformed JSON 3 times in a row"*.
- **Root cause:** gpt-oss responses are wrapped in `<|channel|>commentary<|message|>{...}<|return|>` tokens. Plain `JSON.parse` rejects everything because of the angle-bracket framing.
- **Fix:** `server/src/providers/base-provider.ts: stripHarmonyFraming()` peels the wrapper before parsing. When the parsed JSON looks like raw tool args (no `kind`), `inferToolFromArgs()` synthesises a `needs_tool` envelope.
- **Test guard:** `server/src/providers/__tests__/harmony-framing.test.ts`.

## Same-file edits raced when batched

- **Source:** PR #8
- **Symptom:** agent logged *"I've encountered repeated issues trying to update src/routes/productRoutes.js. Despite multiple attempts using write_file with the complete content, the changes are not being applied correctly."*
- **Root cause:** `executeToolsBatch` ran all `edit_file` calls in `Promise.allSettled`. Two edits targeting the same file ran in parallel; each `search/replace` operated on the file as it found it; writes stomped on each other; only one survived.
- **Fix:** `cli-client/src/agent/tool-meta.ts: groupForParallelExecution()` groups same-path write/edit calls together. Within a group → sequential; across groups → still parallel. Different-file batches keep their parallelism (a 30-file scaffold still goes in one shot).

## `process.stdin.isTTY` lies through bin/sys.js spawn on Windows

- **Source:** PR #2 / Phase 9 Stage 2 fixup
- **Symptom:** *"Could not establish a chat session"* warning printed above the Ink status line on startup, before user typed anything.
- **Root cause:** in PowerShell on Windows, the `bin/sys.js` spawn shim sometimes hands the child node a stdin that ISN'T reported as a TTY even though the parent terminal is interactive. That made `sys` (no args) take the piped-input branch in `index.ts`, call `runAgent` with an empty/garbage prompt, and print the chat-warning.
- **Fix:** check `SYS_INK` BEFORE the `!isTTY` check; when Ink mode is on, skip `readStdin` entirely. Ink owns the input loop in interactive mode.

## Free-tier OpenRouter affordability ceiling is ~15k tokens

- **Source:** PR #14
- **Symptom:** prompts aborted with `OpenRouter error 402: "You requested up to 32768 tokens, but can only afford 15018."`
- **Root cause:** OpenRouter free accounts carry only a few thousand spendable credits at a time. Asking for 32768 max_tokens per turn exceeds what the balance can buy.
- **Fix:** **don't preemptively cap max_tokens** (that truncates responses even when credits are fine). Instead: (a) Phase 10 chunked loop bounds main-model output naturally to ≤5 files / ≤2500 lines per turn; (b) on 402 specifically, parse the affordable number from the error body and retry once with a 10% safety margin below it (`parseAffordableTokens()` in `openrouter.ts`).

## Continuation prompts ("continue the task") used to spawn the canned task pipeline

- **Source:** PR #11 → fully fixed by removing the fallback pipeline entirely (PR #13, closes #12)
- **Symptom:** typing `continue the task` after an interrupted run produced a *Setup project / Implement features / Polish & finalize* box at the top.
- **Root cause:** the user-message handler called `createFallbackPipeline()` whenever the AI returned `needs_tool` without its own `taskPlan`. Each whack-a-mole patch (PR #4, #7, #11) just narrowed the gating; the real fix was to never call the generic fallback at all.
- **Fix:** `createFallbackPipeline` is no longer called from the generic path. The task box only renders when the AI itself produces a `taskPlan`. The error-fix path still uses `createFallbackPipeline` because it passes real error-derived step labels.

## Free models commit to a wrong direction at chunk 1 and ride it to the end

- **Source:** plan `applied/2026-05-06-phase-11-awareness-and-recovery.md` (the entire Phase 11 motivating problem)
- **Symptom:** user asks for *"a postgres-backed user API"*, free-tier model writes Mongoose code in chunk 1, every subsequent chunk extends the wrong stack. Other shapes: scaffolds for stack X then implements stack Y; says *"implementation complete"* with empty `controllers/` and `models/` folders; retries the same broken edit despite repeated tool failures; never re-reads its own files so its mental model diverges from disk.
- **Root cause:** chunked loop's per-chunk reflector (Phase 10) catches *micro* errors ("import didn't resolve") but not *macro* errors ("you've been building Express + MongoDB but the user said Postgres"). The agent had no mechanism to realise it was committed to the wrong direction.
- **Fix:** Phase 11 awareness loop. Three independent signal sources (heuristic detector + verification gate + LLM divergence pipeline anchored on the LITERAL user prompt) feed one per-run confidence tracker. When confidence drops below `awareness.threshold_blocked`, an off-course modal hands the wheel back with continue/backtrack/redirect. Free-model thresholds are bumped +10 (Stage 7) so the modal trips earlier on the models that need it most.
- **Test guards:**
  - `server/src/services/__tests__/divergence-detector.test.ts` — heuristic table tests
  - `server/src/services/__tests__/verification-gate.test.ts` — tmpdir fixtures per disk-side check
  - `server/src/services/__tests__/confidence-tracker.test.ts` — decay, threshold transitions, free-model bump
  - `cli-client/src/agent/__tests__/git-snapshots.test.ts` — real git-init repo + rollback roundtrip

## Intent-keyword extractor was greedy on hyphens — `postgres-backed` slipped past

- **Source:** Phase 11 Stage 1 (PR #22, caught while writing the heuristic-detector tests)
- **Symptom:** test case `extractIntentKeywords("build a Postgres-backed user API")` returned `[]`, missing the obvious `postgres` keyword. In production this would mean the `intent_keyword_absent` heuristic never fires for prompts using the common adjective form ("postgres-backed", "react-based", "tailwind-style") even when the implementation didn't use the named tech.
- **Root cause:** the extractor regex `[a-z][a-z0-9-]+` is greedy and matches `-`, so `postgres-backed` came out as a single token. INTENT_VOCAB has `postgres` and `react-native` (a legit two-part name) but not every hyphen combination.
- **Fix:** try the whole token first (so `react-native` keeps winning as a single vocab entry), and only on miss split on `-` and re-check each part. `extractIntentKeywords` in `server/src/services/divergence-detector.ts`.
- **Test guard:** the divergence-detector test suite has the failing case + the `react-native` regression case to make sure the whole-token-first path isn't regressed.

## `AgentResp.awarenessChoice` masquerades as a normal `waiting_for_user`

- **Source:** plan `applied/2026-05-06-phase-11-awareness-and-recovery.md` (Stage 4)
- **Symptom:** if a future contributor adds another `waiting_for_user` shape and forgets to peek at `awarenessChoice`, the cli would render the off-course evidence as plain text via `askUser` and the user's free-text answer would be sent back as `{ answer: "c" }` with no `kind` marker — the server's off-course branch would never fire.
- **Why this design:** Phase 11 piggybacked on the existing `waiting_for_user` status to avoid adding a new top-level status to the cli/server protocol. The `awarenessChoice: true` marker on the response (plus `awarenessEvidence` for the modal payload) is the discriminator.
- **What to do:** when adding a new modal, add a NEW marker field (`scaffoldChoice`, `permissionChoice`, etc.) and check it BEFORE the generic `askUser` in `cli-client/src/agent/agent.ts`'s `user_responded` case. Never overload `awarenessChoice` for a different prompt — split into a new field instead.

## Truecolor banding on legacy ConHost (and how `color-lerp` falls back)

- **Source:** plan `applied/2026-05-07-phase-12-living-cli-ui.md` (Stage 1)
- **Symptom:** on Windows ConHost (the pre-2019 console), Phase 12's smooth gradients (awareness badge confidence transition, breath colour interpolation) render as banding through the 16 ANSI colours — green and yellow approximate to the same dim cyan, the smooth lerp looks like a hard cut.
- **Root cause:** `chalk.level` is 1 (basic 16) or 2 (256) on legacy ConHost, not 3 (truecolor). A `chalk.hex("#7CXXXX")` call on level ≤ 2 silently snaps to the nearest of 256 (or 16) — a smooth 100-step lerp lands on 4-5 distinct colour cells, which reads as banding.
- **Fix:** `cli-client/src/ui/animation/color-lerp.ts` checks `chalk.level >= 3` to decide between truecolor (smooth) and a discrete-stops fallback (default 4 stops). The fallback intentionally snaps to a small number of evenly-spaced palette colours so the banding is intentional-looking instead of noisy.
- **What to do:** never `chalk.hex()` directly for an animated colour; always go through `lerpHex()` / `paint()` / `confidenceGradient()` so the fallback path is taken. If you add a new gradient, define its endpoints in `theme.ts: gradient` and reuse `lerpHex` — don't roll your own RGB lerp.

## `--no-motion` contract — every primitive renders settled state

- **Source:** plan `applied/2026-05-07-phase-12-living-cli-ui.md` (Stage 2)
- **Symptom:** if a future component reads `useFrame` directly and ignores `isMotionEnabled()`, it'll appear blank (frame 0) when `--no-motion` is on, because `useFrame` emits exactly one settled tick then exits in motion-disabled mode.
- **The contract:** every animation primitive (`<Breath>`, `<Pulse>`, `<Shimmer>`, `<Fade>`, `<Typewriter>`) MUST render a meaningful settled state when motion is disabled. Specifically:
  - `<Breath>` paints its `to` colour (the bright endpoint, not the trough).
  - `<Pulse>` paints `settle` (skipping the flash).
  - `<Shimmer>` paints every char in `base` (no highlight).
  - `<Fade>` paints the destination colour and fires `onDone` synchronously via `queueMicrotask`.
  - `<Typewriter>` renders the full text and fires `onDone` synchronously.
- **What to do:** when adding a new primitive, write the test for `--no-motion` mode FIRST. The test should call the pure shape function with `isMotionEnabled() === false` (set via `setMotionEnabled(false)`) and assert the settled output is non-empty + matches the expected destination state.

## `useFrame` motion-listener registration is lazy on purpose

- **Source:** plan `applied/2026-05-07-phase-12-living-cli-ui.md` (Stage 1)
- **Symptom:** during early development, tests that called `_resetForTests()` on the motion store + then flipped `setMotionEnabled(false)` mid-test couldn't get the `useFrame` scheduler to stop. The timer kept ticking until the next subscriber detached.
- **Root cause:** `useFrame` registered its motion-change listener at module-load time. When a test reset the motion store (`_resetForTests` clears the listener Set), the registration was lost and the next motion-state flip had no listener to call `stop()`.
- **Fix:** lazy-register inside `subscribeFrame` / inside the `useEffect` of `useFrame` itself, via `ensureMotionListener()` which is idempotent. `_resetForTests` on the use-frame side also clears the registration so the next subscribe gets a fresh listener (covers the case where motion was already reset between tests).
- **What to do:** if you add another module-level cross-store listener (e.g. a future awareness-state subscription), use the same lazy pattern. Module-load-time registrations are silently broken by test resets and the failure mode isn't obvious.

## Raw `\x1b[nA` cursor-up writes corrupt Ink's render zone

- **Source:** plan `applied/2026-05-07-phase-14-premium-cli-experience.md` (Stage 1)
- **Symptom:** during a multi-tool turn the terminal would scroll up and down on its own, the user couldn't keep their viewport stable, and the in-flight tool list rendered partly under previous lines.
- **Root cause:** `cli-client/src/agent/agent.ts` (around line 1048) printed `○` placeholders for the in-flight tools, then ran `process.stdout.write("\\x1b[${toolCalls.length}A")` followed by `\\r\\x1b[K` per line to move the cursor back up and overwrite each row with the resolved `✔ / ✖`. That dance works fine for a raw console renderer that owns the bottom rows. With Ink mounted, the cursor escapes land INSIDE Ink's reserved render region — Ink then re-paints that region without knowing the cursor is offset, so subsequent frames overlap, scroll, or partially erase prior content.
- **Fix:** every raw cursor-up / clear-line write is gated behind `shouldRenderInlineForLegacy()` (`agent/events.ts`). In Ink mode the visible representation of "running tools" is the live `<ActionCard>` set in `<AgentStream>` — re-printing rows is unnecessary AND breaks layout.
- **What to do:** never call `process.stdout.write` with VT100 cursor escapes from a code path that might run with Ink active. If the path needs both modes, use the `shouldRenderInlineForLegacy()` gate. If it's Ink-only, emit a structured event and let the reducer drive the visual transition.

## Read-only commands used to require approval per call — agent gave up on investigation

- **Source:** plan `applied/2026-05-13-command-first-investigation.md` (Stage 2)
- **Symptom:** with the new command-first directive in place (Stage 1), the agent dutifully tried to investigate first — `git status`, `ls`, `grep -rn Foo src/`, `find . -name '*.config.*'` — but EVERY one of those commands hit the permission prompt. Users in `default` permission mode (the default) saw a wall of `Allow?` questions on the very first turn. The session became unusable: either the user spammed `y` 10 times to let investigation proceed, or the agent gave up after 2 deny-by-default timeouts and fell back to `read_file` — silently undoing the prompt directive.
- **Root cause:** `cli-client/src/agent/permissions.ts` treated every `run_command` as `ask` regardless of what the command actually did. The permission gate had no notion of "safe read-only investigation" vs "actually destructive shell command". `git status` was rated the same risk level as `rm -rf /`.
- **Fix:** Stage 2 introduced `cli-client/src/agent/safe-commands.ts: isSafeReadOnlyCommand(cmd)` — a regex-based whitelist of canonical investigation commands (`git status|log|diff|branch|remote|show`, `ls|dir`, `find`, `grep|rg|Select-String`, `cat|type|head|tail|Get-Content`, `which|where`, `whoami|pwd|Get-Location`, `npm list|outdated|ls`, `node -v`, etc.). Conservative on chained / piped / sub-shelled commands (`&&` / `||` / `;` / backticks immediately fail the check). `permissions.ts` consults the function BEFORE returning `ask`; if safe, returns `allow` and logs `[permissions] safe-command auto-approved: <cmd>`.
- **Setting:** `cli-client/src/lib/sysbase.ts: commands.auto_approve_safe` (default `true`). Users who want to see every command can flip to `false`.
- **Test guard:** `cli-client/src/agent/__tests__/safe-commands.test.ts` covers (a) positive cases for every command in the whitelist, both bash and PowerShell forms; (b) negative cases for write variants, chained writes, and suspicious patterns (backticks, command substitution wrapping a write).
- **What to do when adding a new safe command:** add to the regex in `safe-commands.ts`; add a positive case in the test file; if the command can chain something destructive (e.g. `xargs rm`), make sure the existing chain-detection regex rejects it. Default to NOT safe — false positives ruin the pattern.

## run_command on Windows hit cmd.exe, breaking every bash-form alias the LLM emits

- **Source:** user-reported regression (2026-05-15)
- **Symptom:** the LLM emits `ls -R` (auto-approved by the safe-command allowlist) on Windows and the executor responds with the canonical cmd.exe error: *"'ls' is not recognized as an internal or external command, operable program or batch file."* Same shape for `cat`, `grep`, `head`, `tail`, `find` (the Unix-style version), `wc`, etc. The agent then either gets stuck on the failed turn or pivots to weird recovery (e.g. web-searching for tsconfig instead of trying `dir`).
- **Root cause:** every `child_process.spawn` callsite in the CLI that runs an agent-emitted command spawned **`cmd.exe`** on Windows (`tools.ts:551 / 749 / 880` + `background-jobs.ts:89`). cmd.exe doesn't have `ls`, `cat`, `grep`, etc. — those are PowerShell aliases (`Get-ChildItem`, `Get-Content`, `Select-String`) or Unix-only. The LLM emits bash-form commands by default because that's what most public codebases use; routing through cmd.exe broke them all.
- **Fix:** new `cli-client/src/agent/shell.ts: getShellInvocation(command, platform?)` returns `{ shell, args }`. On Windows it returns `{ shell: "powershell.exe", args: ["-NoProfile", "-Command", "<command> ; exit $LASTEXITCODE"] }`. PowerShell 5.1 is bundled with every Windows release since Windows 7; the aliases (`ls → Get-ChildItem`, `cat → Get-Content`, `cp → Copy-Item`, ...) cover the bash-form commands the LLM emits. All four spawn callsites use the helper. PR also reworks the `searchCodeTool` Windows branch — previously it spawned cmd.exe then invoked `powershell -NoProfile -Command "..."` as a nested process; that wrapper is gone now that the outer shell IS PowerShell.
- **The `; exit $LASTEXITCODE` suffix matters:** PowerShell 5.1's `-Command` exits with code 0 on a "clean" PS run even when the inner native command (`node script.cjs 7`) exited non-zero. cmd.exe propagates native exit codes for free; switching to PowerShell would have lost that without the explicit `exit $LASTEXITCODE` at the end. The background-jobs test suite caught this — `node fail-fast.cjs 7` was returning exit 1 instead of 7 until the suffix was added.
- **Test guard:** `cli-client/src/agent/__tests__/shell.test.ts` covers: PowerShell on win32 vs `/bin/sh` on linux/darwin/freebsd; the `; exit $LASTEXITCODE` suffix; the user-reported `ls -R` case; common bash forms (`cat`, `grep`, `head`, `tail`, `find`); default-platform fallback. `background-jobs.test.ts: poll returns failed with non-zero exit` is the regression guard for the exit-code propagation.
- **What to do when adding a new platform-aware spawn site:** import `getShellInvocation` and use it. Don't re-derive `process.platform === "win32"` in your callsite — that's how the bug crept into four places. If you need an isWindows flag for an UNRELATED concern (e.g. `taskkill` vs `SIGTERM` on the timeout path), keep that branch separate; the SHELL pick goes through the helper.

## ReasoningPeek surfaced structured-field text instead of plain-prose reasoning chain

- **Source:** user-reported regression (2026-05-15)
- **Symptom:** the `<ReasoningPeek>` block in the CLI showed structured form-field output for non-implement runs:
  ```
  ✦ Reasoning(bug)
    → symptom: User requested to build a new Node.js Express PostgreSQL backend ...
    → boundary: unknown
    → fix: The request is for new feature development, not a bug fix. No fix is ...
  ```
  The `symptom` line is plainly NOT a symptom — it's a description of the user's build request. The `bugBrief.symptom` field was populated with whatever Flash produced when forced into the rigid schema, even though the actual run wasn't a bug. **The LLM's real reasoning chain (plain-prose paragraphs in `reasoningChain[]`) was invisible** — the renderer only looked at the structured fields.
- **Root cause:** `cli-client/src/ui/components/ReasoningPeek.tsx: formatBriefSummary` extracted lines from each pipeline's structured fields (`bugBrief.symptom`, `bugBrief.suspectedBoundary`, `bugBrief.proposedFix.description`, etc.). It never consulted `briefData.reasoningChain` — the paragraph chain that `runIterativeChain` had been producing since Stage C of model-lock-and-portable-reasoning (PR #65). So the most natural surface for the LLM's deliberation was rendered out, and a form-field text artefact took its place.
- **Fix:** new plain-prose preference at the top of `formatBriefSummary`. When `briefData.reasoningChain` is a non-empty array of strings, render those paragraphs as the peek body (up to 3, each truncated to 180 chars, with a `→ (+N more paragraphs)` tail if the chain is deeper). Structured-field rendering stays as the fallback for pipelines that don't yet produce a chain (`chunk_plan`, `chunk_reflect`, divergence verdict) — they keep their current peek shape.
  - The structured fields (`bugBrief.symptom`, `implementBrief.recommendedStack`, etc.) stay on the schema because downstream code consumes them (divergence detector reads `bugBrief.suspectedBoundary`; the `<AgentStream>` task block reads `implementBrief.buildPlan`).
  - Two exported helpers — `formatPlainReasoningChain(kind, paragraphs)` and `pipelineLabelFor(kind)` — keep the chain path testable and centralise the canonical label mapping so the chain path and the structured-field path always agree on `Reasoning(<kind>)`.
- **Test guards:**
  - `cli-client/src/ui/components/__tests__/ReasoningPeek.test.ts` — three new describe blocks cover: chain-preferred-over-structured for every pipeline kind, +N tail for long chains, singular vs plural tail, truncation, malformed-entry filtering, and the explicit fallback paths (empty / missing / non-array / whitespace-only chain → structured render fires)
- **What to do when adding a new pipeline:** if the pipeline produces deliberative reasoning (iterative chain), `reasoningChain[]` will populate automatically and the plain-prose render path kicks in for free. Only add a new structured-field render block in `formatBriefSummary` if the pipeline's output is genuinely STRUCTURED (a file list, a coherent verdict, a divergence score) — those benefit from the labelled-line rendering. Decision rule mirrors `decisions.md: ## Planner ↔ reflector are additive, not merged` — paragraph chain for deliberation, structured form for concrete artifacts.

## "error handling" in a feature list mis-classified build prompts as bug reports

- **Source:** PR fixing user-reported regression (2026-05-15)
- **Symptom:** User sent the prompt *"build a Node.js Express PostgreSQL backend ... validation middleware, error handling, pagination, search, and Docker Compose ..."* — a clear implement request. The agent responded as if it were a bug report, asking for *symptom / boundary / fix* context for an app that didn't exist. The reasoning peek confirmed `Reasoning(bug)`.
- **Root cause:** `server/src/reasoning/intent-classifier.ts: BUG_PATTERNS` includes `\b(fix|debug|broken|...|error|...)\b`. The regex matched the word **"error"** inside the feature-list phrase *"error handling"* — a noun, not a verb / not a bug report. Bug-classification ran before the implement default, so it won the routing.
- **Fix:** new `IMPLEMENT_LEAD_PATTERNS` regex that matches a strong build verb at the very START of the prompt (`build`, `create`, `implement`, `make`, `add`, `set up`, `scaffold`, `construct`, `develop`, `generate`, `design`, `write`, `spin up`, `stand up`, `bootstrap`, `produce`, `craft`, `put together`) followed by at least some content. When this anchor matches, the classifier returns `implement` BEFORE the bug check. Bug-reports open with different verbs (`fix`, `debug`, `why is X failing`) and a stack-trace shape; none trip the anchor.
- **Test guards:**
  - `server/src/reasoning/__tests__/intent-classifier.test.ts` — the verbatim user prompt is now a regression test under `## implement-anchor overrides bug-keyword false positives`
  - Same file's `## bug-report prompts still classify as bug` block asserts `fix the broken auth flow with error handling`, `debug why X throws an error`, and stack-trace prompts still route to the bug pipeline
- **What to do when adding a bug pattern:** the bug regexes should match terms that USUALLY appear in bug-report verbs / phrasings (e.g. `\bfailing\b` is fine because *"failing"* almost always means broken; `\berror\b` is risky because of compound nouns like `error handling`, `error logging`, `error middleware`, `error boundaries`, `error events`). When in doubt, add a positive test case for the new pattern AND a negative case for a feature-list compound that contains the same word.
- **What to do when adding an implement-lead verb:** keep the list small and specific. Adding catch-alls like `do` or `handle` would let bug-reports through (e.g. *"do something about this crash"* would start matching the anchor and skip the bug check). The current list is curated for prompts that read like build requests, not action requests.

## Anthropic + OpenRouter providers used to skip the ctx-aware system prompt — briefs never reached the model

- **Source:** plan `applied/2026-05-07-model-lock-and-portable-reasoning.md` (Stage B, PR #64)
- **Symptom:** user picks `claude-sonnet`. The preflight reasoner runs, produces a brief, the brief is cached and sent to the CLI as `reasoningBrief`. The CLI renders `<ReasoningPeek>` showing the brief content. **And then Claude never sees it.** The agent's response shows no awareness of the architecture sketch the reasoner produced. User feedback: *"the model reasoning didn't applied or understood what he reason it just proceed to the task without understanding its own reason"*.
- **Root cause:** `server/src/providers/anthropic.ts` and `server/src/providers/openrouter.ts` were calling `this.systemPrompt` (the static `SHARED_SYSTEM_PROMPT`) instead of `getSystemPrompt(ctx)` (the context-aware variant that includes the dynamic `reasoning-brief` section). Gemini already did the right thing. The bug pre-dated Phase 5 — the brief section had simply never been wired into the non-Gemini provider system-prompt builders.
- **Fix:** both providers now call `getSystemPromptForRequest(payload)` per request, which threads `payload.reasoningBrief` (+ `reasoningElaborationBrief`, cwd, model, git-branch) through the same builder Gemini uses. Same casts at the seam pattern. Both fresh-conversation and continuation branches needed the swap.
- **Test guards:**
  - `server/src/providers/__tests__/brief-injection.test.ts` — asserts each provider's first request carries `═══ REASONING BRIEF` in the system prompt when `payload.reasoningBrief` is set
  - `server/src/providers/prompt/sections/__tests__/reasoning-brief.test.ts` — covers the section's rendered output across HIGH/MEDIUM/LOW confidence variants
- **What to do when adding a new provider:** start from `gemini.ts`'s shape — it's the reference for what a ctx-aware system prompt looks like. If the new provider needs a static prompt (e.g. for prompt-caching), the dynamic suffix (which includes the brief) should still be appended on every request. Static system prompt = brief is invisible to the model = unreachable contract.

## `spinner.text = "thinking..."` as default silently disabled the verb cycle

- **Source:** PR #45 (post-Phase 14 Stage 3 follow-up)
- **Symptom:** users reported the spinner was stuck on `thinking…` for the entire duration of a long pause — the cycling verbs (`debugging`, `searching`, `weighing options`, …) inside `<RichSpinner>` were never showing up. The fix in PR #44 (single-glyph + colour rotation) made the spinner LOOK alive, but the word was still static.
- **Root cause:** `cli-client/src/agent/agent.ts: createSpinner` initialised the Ink shim with `let current = "thinking..."` and emitted `{type:"spinner", text:"thinking..."}` immediately. `<RichSpinner>` only runs the verb cycle when no `text` prop is supplied — a non-empty default text override blocks it from the very first frame. Server phase events that update `spinner.text` later kept it overridden through the rest of the wait, but during the long initial pause before any phase event arrives, the verb cycle never got a chance to run.
- **Fix:** initial text is now `""` (empty). `<AgentStream>` passes `text={spinnerText || undefined}` so empty becomes `undefined`, which lets the cycle take over until a real label arrives.
- **What to do:** when adding a new spinner-driving codepath that needs to surface a specific label, set the text to that label only when you have one. Don't pre-fill with a placeholder ("thinking…", "loading…", "working…") that you intend the cycle to replace — the cycle is contractually disabled while a `text` prop is set.

## Agent demanded tsconfig.json in empty directory and hard-stopped on 0-hit web search

- **Source:** plan `applied/2026-05-15-agent-runtime-fixes-and-project-init-reasoning.md` (the canonical trigger)
- **Symptom:** running `sys` in `C:\Users\DevAPI\Documents\test` (empty dir) with the prompt *"build a Node.js Express PostgreSQL backend for a simple POS system"* produced:
  ```
  ● List(.)
  │ Need to verify current typescript configuration before writing files
  ▸ search web "tsconfig.json configuration 2026"
  ● WebSearch — 0 hits
  │ No tsconfig.json configuration data was found. Please provide…
  ```
  Agent halted. Empty dir, prompt didn't mention TypeScript, but the agent demanded a tsconfig that didn't exist and dead-ended on a 0-hit search.
- **Root cause:** TWO compounding mechanisms.
  1. `action-planner.ts: buildConfigSearchOverride` fires on any first `write_file` call whose path matches a recognised config pattern (`tsconfig` / `vite.config` / `tailwind.config` / `.eslintrc` / etc.). The hijack forces a `web_search` for current setup docs BEFORE the write. Correct for EXISTING projects; wrong for FRESH SCAFFOLDS where the file is being authored from scratch.
  2. The `web_search` tool result for 0 hits was returning `{ results: [] }` with no error — the agent had no recovery hint and no signal that 0 hits is recoverable.
- **Fix:** plan `applied/2026-05-15-agent-runtime-fixes-and-project-init-reasoning.md`:
  - Stage 1 added a `project_init` iterative reasoner that classifies the repo as `empty / small / existing-small / existing-large` BEFORE preflight and seeds a per-run `skipConfigVerificationFor` list on empty/small classifications. The action-planner's hijack now skips authored configs on fresh scaffolds.
  - Stage 2 tagged 0-hit `web_search` results with `_errorCategory: "web_search_empty"` + a recovery hint. The existing error-reasoning chain catches retries.
- **Prevention:** when adding new action-planner hijacks or new tool results that could be no-signal-but-valid, ASK: "what happens in a fresh repo where the precondition isn't met?" and "what's the recovery action if this call returns nothing useful?" The default should never be "agent halts with a 'please provide' message".
- **Test guards:** `server/src/reasoning/__tests__/project-init-reasoner.test.ts` covers the empty-repo classification → skip-list seeding. `server/src/services/__tests__/setup-intelligence-skip.test.ts` covers `detectConfigFile(path, runId)` honouring the skip list. `server/src/services/__tests__/tool-error-classifier.test.ts` covers the `web_search_empty` category.

## Reasoning peek stayed stuck on project_init across multi-turn run

- **Source:** plan `applied/2026-05-16-reasoning-chain-provider-parity.md` (the canonical trigger)
- **Symptom:** running `sys` on `openrouter-auto` against a multi-turn implement task, the cli's live `<ReasoningPeek>` displayed the SAME `Reasoning(project init)` brief on every single turn for the entire run. The agent was clearly reasoning (per-turn `│ <text>` lines appeared inline) but the live peek never updated.
- **Root cause:** THREE compounding mechanisms.
  1. The cli's per-turn brief emission only fires when `response.perTurnReasoningChain` is a non-empty array (Stage 3 of the prior agent-runtime-fixes plan).
  2. Models served via OpenRouter / Anthropic (especially CJS-shaped or smaller free-tier models) populate `response.reasoning` (singular string, legacy field) instead of the structured `reasoningChain[]` (array).
  3. The mapper at the time only forwarded `reasoningChain[]` to `perTurnReasoningChain`; without an array there was nothing for the cli to emit.

  Plus: even on the rare turns where the model DID emit a chain, two server-side overrides in `base-provider.ts` (weak-completion override at `validateCompletionResponse` line ~498, tool-gate override at `parseJsonResponse` line ~1156) constructed new response objects without copying `reasoningChain` forward — so any override fire silently dropped the chain.

- **Fix:** Plan `applied/2026-05-16-reasoning-chain-provider-parity.md`:
  - Stage 1 added `resolvePerTurnReasoningChain()` synthesising a single-element chain from singular `reasoning` when the array is empty.
  - Stage 2 strengthened the system-prompt directive (`tools.ts`) — `reasoningChain` MANDATORY on every needs_tool/completed; removed the "Skip on trivial turns" escape hatch.
  - Stage 3 audited the response parser (all three providers route through one); fixed both overrides to carry the chain forward.
  - Stage 4 added `RunSummary.reasoningChainEmittedTurns` vs `reasoningChainSynthesisedTurns` so the structured-vs-synthesised distribution is trackable.

- **Prevention:** when adding new response-shaping logic in `base-provider.ts`, ASK: "if I'm constructing a new response object, am I dropping fields the model emitted?" The answer for `reasoningChain` and `reasoning` should always be: carry forward. Spread the original or explicitly copy.

- **Test guards:** `server/src/providers/__tests__/normalize-per-turn-reasoning.test.ts` (synthesis paths), `server/src/providers/prompt/sections/__tests__/tools-reasoning-chain-directive.test.ts` (MANDATORY directive present), `server/src/providers/__tests__/reasoning-chain-override-preservation.test.ts` (override preservation), `cli-client/src/agent/__tests__/usage-log.test.ts` (telemetry counters).

## Agent tried to write server/.env in user project to fix sysflow's OpenRouter credits

- **Source:** plan `applied/2026-05-16-server-hardening-and-error-source-distinction.md` (the canonical trigger)
- **Symptom:** running `sys` against the user's `test` directory hit sysflow's OpenRouter quota during a model call:
  ```
  ✖ OpenRouter is out of credits and even the lowest affordable max_tokens would be too small to be useful.
    Top up at https://openrouter.ai/settings/credits, switch model with /model gemini-flash,
    or set GEMINI_API_KEY in server/.env (free tier from Google AI Studio).
  Auto-retrying (1/5)...
  ✖ ...same error...
  Auto-retrying (2/5)...
  │ The previous tool execution failed due to insufficient credits on OpenRouter. The error message
  │ explicitly suggests setting the `GEMINI_API_KEY` in `server/.env` to utilize Google AI Studio's
  │ free tier as a solution. This is a viable alternative to topping up credits...
  ▸ create server/.env +1
  ● Write(server/.env)
  ─ error: ⛔ PERMISSION DENIED: tool "write_file" was denied by the active permission policy.
  ```
  The agent literally tried to mutate `server/.env` IN THE USER'S PROJECT DIRECTORY to fix sysflow's own backend.

- **Root cause:** THREE compounding mechanisms.
  1. The OpenRouter 402 failure was returned as a `failed` envelope with NO `errorSource` tag — the cli's state machine fell through to `failure_retry` and the cli retried 5x against the same exhausted credit pool.
  2. The failure's error string (which contains the suggestion to set `GEMINI_API_KEY in server/.env`) reached the agent's error-reasoning chain as if it were a tool-execution error from the user's machine.
  3. The chain interpreted the suggestion as actionable from inside the project — wrote `write_file` against `server/.env` relative to the user's cwd.

  Plus: the cli's retry classifier was message-substring based — it only skipped retry when the thrown error message contained the literal `"Server error"` prefix. SSE-event error paths drop that prefix → retry fired.

- **Fix:** Plan `applied/2026-05-16-server-hardening-and-error-source-distinction.md`:
  - Stage 1 added the `KNOWN_TOOL_NAMES` registry-derived set + `isKnownTool` gate (catches null tool names at source — separate but related failure mode).
  - Stage 2 added `errorSource: "sysflow_infra" | "user_machine" | "unknown"` on every error envelope. Providers tag their quota / auth / 5xx as `sysflow_infra`. Cli state machine halts terminally on `sysflow_infra` with a distinct banner.
  - Stage 3 added the cli `NonRetryableError` class + `classifyNonRetryable()` detector matching PG constraints + app validation + `sysflow_infra` envelope tag. Bypasses the retry loop via `instanceof`, not message format.
  - Stage 4 added OpenRouter's `classify402Terminal()` — skip internal retry when affordable < 4096 OR body says `Insufficient credits`.
  - Stage 5 added telemetry counters (`sysflowInfraErrorCount` / `nullToolRejectionCount` / `nonRetryable5xxCount`) + this gotcha.

- **Prevention:** when adding a new failure path or error envelope, ASK: "could the AGENT interpret this error as something to fix from inside the user's project?" If yes, tag with `errorSource: "sysflow_infra"`. The discriminator is the safety contract; message-pattern matching is fragile and provider-dependent.

- **Test guards:** `cli-client/src/agent/__tests__/state-machine-sysflow-infra.test.ts` (terminal classification), `server/src/providers/__tests__/error-source-propagation.test.ts` (failedResponse + mapper propagation), `cli-client/src/lib/__tests__/server-non-retryable.test.ts` (cli retry classifier), `server/src/providers/__tests__/openrouter-402.test.ts: classify402Terminal` (provider-side bail-out).

## Agent shipped a POS backend with cascading ESM import failures + no database schema

- **Source:** plan `applied/2026-05-16-agent-code-correctness-and-completion-artifacts.md` (canonical trigger)
- **Symptom:** user ran `sys` against `C:\Users\DevAPI\Documents\test` with prompt *"Build a clean and scalable Express.js POS backend"*. Agent scaffolded files + declared "completed". User ran `npm run dev` and hit:
  ```
  ReferenceError: authRoutes is not defined  at src/index.ts:17:22
  Error: Cannot find module 'C:\...\src\config\db' (ESM .ts extension required)
  SyntaxError: Named export 'NextFunction' not found (Express is CJS)
  SyntaxError: The requested module './middleware/errorHandler.ts' does not provide an export named 'default'
  ```
  Plus the completion summary said: *"## Notes — Database schema creation is a manual step for the user."* User had to manually create schema.sql AND fix every TS import.
- **Root causes (FIVE compounding mechanisms):**
  1. System prompt had ZERO Node-ESM rules — model emitted bare relative imports (no `.ts` extension), default-imported a file with only named exports, named-imported a TypeScript type from a CommonJS package.
  2. The cli's `sanitizeImports` SILENTLY stripped bad imports — file landed with unimported names, never reported back to the model.
  3. No pre-completion `tsc --noEmit` gate — model declared done without compilation check; runtime errors only surfaced at `npm run dev`.
  4. No prompt-implied artifact verification — agent claimed completion despite the prompt explicitly mentioning Postgres + no schema file written.
  5. Completion summary disclaimer culture: agent shipped *"manual step for the user"* whenever in doubt, treating schema creation as out-of-scope when the prompt said otherwise.
- **Fix:** plan `applied/2026-05-16-agent-code-correctness-and-completion-artifacts.md` — five stages + LLM-driven follow-up:
  - Stage 1: NODE-ESM + TS IMPORT RULES section in `tools.ts`, gated on Node/TS via project-init `keyMarkers` (skips on Python/Rust/Go).
  - Stage 2: cli `sanitizeImports` now surfaces `_strippedImports` on results; server injects `═══ IMPORTS STRIPPED ═══` block via `actionPlanner.injectContext`.
  - Stage 3: pre-completion `tsc --noEmit` gate via `runTscGate()`. Overrides `completed` → `needs_tool` + injects `═══ TYPECHECK FAILED ═══` block with diagnostics.
  - Stage 4: prompt-implied artifact gate. Initially hardcoded keyword matching; immediately replaced with LLM-driven `expectedArtifacts` from project-init reasoner (PR #112) to avoid false positives on Q&A / casual-mention prompts.
  - Stage 5: telemetry counters (`importsStrippedCount` / `tscErrorCount` / `completionBlockedReason`) + KB.
- **Prevention:** when authoring new completion paths or extending the completion guard, ASK: "what's the runtime check that would catch the agent shipping broken code?" If `tsc --noEmit` / `node --check` / `npm test` would catch it, add it as a gate. The cost is one process invocation; the benefit is no broken shipments. Also: never let the agent ship a "manual step for the user" disclaimer for work the prompt explicitly named (DB schema when prompt mentions Postgres, tests when prompt mentions testing).
- **Test guards:** `server/src/providers/prompt/sections/__tests__/node-esm-rules.test.ts` (33 tests: rules + language gate), `server/src/services/__tests__/import-stripped-inject.test.ts` (15 tests: pure helpers), `server/src/services/__tests__/tsc-completion-gate.test.ts` (23 tests: orchestrator + skip paths + error extraction), `server/src/services/__tests__/completion-artifact-gate.test.ts` (41 tests: keyword classifier + fs walker + LLM-driven tier), `server/src/reasoning/__tests__/project-init-reasoner.test.ts` (`expectedArtifacts` schema + LLM commit path).

## `.env.example` flagged stale immediately after creation (dotfile filter false-positive)

- **Source:** plan `applied/2026-05-16-awareness-and-verification-correctness.md` (Stage 1)
- **Symptom:** `[directory-refresh] 1 stale top-level file(s): .env.example` fired one turn after the agent successfully wrote `.env.example`. The agent then assumed the file was gone and either re-created it or worked around its absence — wasted turns + degraded confidence. Same problem reproduced for `.gitignore`, `.eslintrc.json`, `.npmrc`, `.prettierrc`, `.editorconfig`, `.nvmrc`, `.dockerignore`.
- **Root cause:** `captureTopLevelTree` in `cli-client/src/agent/executor.ts` filtered `!e.name.startsWith(".")` to keep the snapshot small — stripped EVERY dotfile, including the legitimate ones the agent commonly authors. Server's `ingestDirectoryTree` (which had been extended for staleness detection in the prior runtime-fixes plan) still tracked `.env.example` in `ctx.files` from the just-completed `write_file`. Comparison: tracked-but-not-in-tree → stale. False positive.
- **Fix:** Replaced the broad dotfile filter with `NOISE_TOP_LEVEL_ENTRIES` — a narrow set (`.git`, `.DS_Store`, `.vscode`, `.idea`, `node_modules`, `__pycache__`, `.pytest_cache`, `.mypy_cache`, `.next`, `.nuxt`, `dist`, `build`, `.turbo`, `.cache`) plus the `sysbase*` prefix. Mirrored on the server side at `ingestDirectoryTree` so both sides agree. A literal-sync test pins the parity.
- **Prevention:** when designing per-turn diff systems, ensure the EMITTER and the CONSUMER share the same filter constants (literal-sync tests work for this). Asymmetric filters silently desync the comparison. Avoid `startsWith(".")` as a filter for "irrelevant files" — way too broad; specify the actual noise entries by name.
- **Test guards:** `server/src/services/__tests__/context-manager-stale-files.test.ts` (22 tests: regression for `.env.example` / `.gitignore` / `.eslintrc.json` + noise set membership + integration with staleness loop), `cli-client/src/agent/__tests__/top-level-noise-filter.test.ts` (11 tests: cli predicate semantics + cli/server parity literal-sync check).

## Windows `ls -la` reported success despite the PowerShell cmdlet rejecting `-la`

- **Source:** plan `applied/2026-05-16-awareness-and-verification-correctness.md` (Stage 4)
- **Symptom:** the agent ran `ls -la`, the cli rendered:
  ```
  ● Bash(ls -la)
  ─ + FullyQualifiedErrorId : NamedParameterNotFound,Microsoft.PowerShell.Commands.GetChildItemCommand
  ✔ ls -la
  ```
  User saw BOTH the error message AND `✔` — bad signal. The cmdlet never actually ran but the agent's tool-result reported success.
- **Root cause:** PowerShell aliases `ls → Get-ChildItem`. `Get-ChildItem -la` is parsed by PowerShell's parameter binder, which rejects `-la` with a non-terminating ErrorRecord on stderr. `$LASTEXITCODE` stays at whatever it was before the cmdlet ran (often 0 from a previous command); `; exit $LASTEXITCODE` exits with 0. The cli's close-handler check `if (code !== 0 && !stdout)` evaluates false (`code === 0`), so the result resolved as success — but stderr had the error.
- **Fix (two-pronged, both load-bearing):**
  - **Proactive (Stage 4.1):** thread `body.client.platform` from the cli to the server so the system prompt's `═══ ENVIRONMENT ═══` block tells the model the user's actual OS. Pre-Stage-4.1 the server's `process.platform` lied (SaaS deployment server is Linux); every Windows user got `platform: linux` + bash-style command examples and the model dutifully emitted `ls -la`. Post-Stage-4.1 the model sees `platform: win32` + `Get-ChildItem` examples and emits PowerShell-native commands directly.
  - **Reactive (Stage 4):** when the model still emits bash forms (training-data inheritance is strong), `remapWindowsShellCommand` in `cli-client/src/agent/win-shell-aliases.ts` rewrites common Unix forms to PowerShell equivalents BEFORE dispatch (`ls -la` → `Get-ChildItem -Force`, etc.). For anything the remap missed, `detectPowerShellError(stderr)` scans for cmdlet-binding markers (`FullyQualifiedErrorId`, `ParameterBindingException`, `NamedParameterNotFound`, `MissingArgument`, `+ CategoryInfo`) and marks the result `success: false` regardless of exit code.
- **Prevention:** never trust `$LASTEXITCODE` on a PowerShell `-Command` to faithfully reflect cmdlet failures — it only captures NATIVE exit codes. For cmdlet-binding errors you have to inspect stderr. When piping commands through PowerShell, ALSO surface the user's actual platform into prompt-building so the model emits native syntax instead of bash. The two layers compose: prompt-aware emission (fewer rewrites needed) + reactive remap (catches the leakage) + stderr inspection (catches anything the remap missed).
- **Test guards:** `cli-client/src/agent/__tests__/win-shell-aliases.test.ts` (22 tests: each Unix alias remap, conservative non-remap of subtle shapes, stderr marker detection, user-repro `ls -la`), `server/src/providers/__tests__/client-platform-threading.test.ts` (11 tests: platform threads through both Anthropic + OpenRouter prompt builders + provider parity), `server/src/services/__tests__/run-platform-store.test.ts` (9 tests: per-run platform store).

## Agent wrote 11 tools in parallel and produced broken imports

- **Source:** plan `applied/2026-05-16-accountability-and-parallel-execution-sequencing.md`
- **Symptom:** the agent emitted 11 parallel tool calls in one response (3 mkdirs + 8 writes) on a fresh scaffold. The cli ran them via `Promise.allSettled` — every group raced. The agent's `reasoningChain[]` had ONE paragraph for the whole batch (*"Create the required folder structure and source files for middleware, utilities, and route handlers"*). After the batch landed, the agent declared scaffold complete WITHOUT reading any of the files back. Result: `src/index.ts` imported `./routes/auth`, but `src/routes/auth.ts` lost its `export const auth` content because the import-sanitizer ran on `index.ts` BEFORE `routes/auth.ts` had been written (race). Net: a "complete" scaffold with broken files, no per-file reasoning, no verification.
- **User quote:** *"it's not accounting what he did, like in the parallel execution it's just make the parallel files without asking why it should be that file"* + *"our ai lacks accountability, reasoning use, memory, and it hallucinated so badly"*.
- **Root causes (five compounding):**
  1. **No per-file reasoning enforcement** — the agent could ship one generic paragraph for any batch size.
  2. **No batch cap** — `Promise.allSettled` ran whatever the agent emitted.
  3. **No producer-before-consumer ordering** — same-batch writes raced regardless of import dependencies.
  4. **No read-back forcing** — the agent declared done without verifying the writes landed as intended.
  5. **No cross-batch duplicate detection** — the agent could re-write files it had already authored, silently overwriting.
- **Fix (six-stage plan + 5 mechanical layers):**
  - **Stage 1 (cli-side):** `applyBatchCap` defers tools beyond cap=3 (or 5 on existing-large) with synthetic `batch_cap_enforced` failures.
  - **Stage 2 (cli-side, intra-batch):** `topoOrderParallelWrites` Kahn-sorts producer→consumer edges; dependent writes collapse into one serial group so producers land first. Cycles → `import_cycle` failure.
  - **Stage 3 (server-side, after first scaffold batch):** `═══ READ-AFTER-WRITE REQUIRED ═══` inject via `actionPlanner.injectContext` listing every written path; agent must `batch_read` before next write.
  - **Stage 4 (cli-side, per-write):** `_createdPathsPerRun` per-run Set tracks every successful write; 2nd write to same path → synthetic `already_created` failure unless `_acknowledge_overwrite: true`.
  - **Stage 5 (server-side, before cli dispatch):** `validatePerFileReasoning` rejects responses where `tools.length > 3` AND non-empty `reasoningChain` < `tools.length`; injects `═══ INSUFFICIENT REASONING FOR BATCH ═══` and re-calls adapter (max 3 rejections).
  - **Stage 6 (telemetry):** 5 new RunSummary fields (`maxBatchSize`, `batchCapEnforcedCount`, `reorderedBatchCount`, `alreadyCreatedRejectionCount`, `insufficientReasoningRejectionCount`) so the gates' firing frequency is observable on disk.
- **Prevention:** parallel-batch operations need per-file thinking surface (reasoning chain ≥ batch size) AND per-file ordering (topo sort) AND post-batch verification (read-back inject). Soft warnings get ignored; system-level enforcement (reject + re-call) is the load-bearing pattern. When designing a new batched operation, ask: "what's the per-item reasoning requirement, ordering constraint, and verification point?" — if any one is absent, the agent will skip it on free-tier models.
- **Test guards:** `cli-client/src/agent/__tests__/batch-cap.test.ts` (18 tests: cap math), `cli-client/src/agent/__tests__/topo-ordering.test.ts` (35 tests: import resolution + cycle detection), `cli-client/src/agent/__tests__/already-created-guard.test.ts` (23 tests: per-run path tracking), `server/src/services/__tests__/read-after-write-inject.test.ts` (30 tests: latch + repoState gating), `server/src/services/__tests__/per-file-reasoning-guard.test.ts` (22 tests: predicate + prompt).

## Terminal minimize during summary typeout caused uncontrollable scroll

- **Source:** plan `applied/2026-05-18-ui-ux-polish-and-action-aware-spinner.md` (Stage 1)
- **Symptom:** when the user minimized the terminal while the agent was rendering its final summary (Typewriter-driven `assistant_message`), restoring the terminal triggered a continuous upward scroll that the user couldn't control. Only killing the process recovered. Buffer became unreadable.
- **Root cause (two compounding):**
  1. **`<Typewriter>` never detached from `useFrame`'s per-frame loop after reveal completed.** Every frame after completion still fired `setCount(text.length)`, accumulating Ink reconcile work even though no visible change occurred.
  2. **On terminal minimize/restore, SIGWINCH fires** (often multiple times in close succession). Ink's resize handler triggers a full re-render. Combined with the per-frame setState burst from #1, Ink emitted a flood of VT100 cursor sequences that corrupted the scrollback buffer — same class as gotcha-104 (`Raw \x1b[nA cursor-up writes corrupt Ink's render zone`) but via a different path (per-frame setState compounding, not raw stdout writes).
- **Fix (two layers in `cli-client/src/ui/animation/use-frame.ts`):**
  1. **Return-false detach.** `FrameCallback` signature extended to `(nowMs) => boolean | void`. Returning `false` self-unsubscribes from the pump. `<Typewriter>` returns `false` once the reveal completes AND skips `setState` when `count` hasn't advanced. Settled Typewriters contribute zero per-frame work.
  2. **Resize-pause window.** SIGWINCH listener extends `pausedUntilDateMs = Date.now() + 150ms` on every fire. `pump()` short-circuits while paused. Burst-safe: rapid resize events extend the window without compounding. Ink's own resize re-render runs unimpeded; only per-frame work suspends.
- **Prevention:** any subscriber to a shared per-frame scheduler MUST detach when its work is settled. Long-lived per-frame setState calls on settled state are a latent scroll-storm waiting for a resize event. When designing new animation primitives, ask: "what's the completion signal, and does the loop honour it?" If the primitive has a one-shot reveal (Typewriter, Pulse, Fade), it MUST detach at completion.
- **Test guards:** `cli-client/src/ui/animation/__tests__/use-frame.test.ts` (11 new tests: return-false detach + resize-pause window — 4 detach behaviours + 4 pause-window behaviours + burst-safe extension + per-tool isolation).

## Spinner verb cycle ran during tool dispatch, hiding the actual action

- **Source:** plan `applied/2026-05-18-ui-ux-polish-and-action-aware-spinner.md` (Stage 2)
- **Symptom:** user reported: *"the spinner label just keep changing word without a meaningful ai actions it didn't even realize what the agent does it just randomly changing labels in an interval."* The Phase 14 `<RichSpinner>` cycled through 22 verbs on a 3-second timer regardless of what the agent was actually doing. Mid-`write_file` it showed `polishing…` or `weighing options…`.
- **Root cause:** the spinner label source was the explicit `spinnerText` event emitted by `agent.ts`. `agent.ts` only set generic labels (`thinking…`, `executing N tools…`). The reducer never observed the in-flight tool dispatch — even though `tool_start` / `tool_end` events already tracked it.
- **Fix:** pure `resolveSpinnerLabel(toolCards, explicitText)` in `<AgentStream>`. Priority:
  1. Running tool card → action-aware label via `formatRunningCardsForSpinner` (verb-first vocabulary: `writing src/index.ts`, `reading 3 files`, `running npm install`, `searching for "express"`).
  2. Explicit phase label (`retrying after rate limit…`).
  3. Empty → verb cycle (idle fallback).
  Multi-card aggregation: same file-tool → `writing N files`, mixed → `running N tools`. The `reason` tool's per-tool verb is `thinking through it` to match the cycle's vocabulary so the transition reads as the same activity.
- **Prevention:** when wiring a new visual surface to existing state, prefer composing from existing reducer slots over adding new events. The user-reported pattern was solvable by filtering `toolCards` by `status === "running"` — no new bus protocol needed. New events are a code smell; existing state usually carries the info if you look.
- **Test guards:** `cli-client/src/ui/__tests__/spinner-label-format.test.ts` (30 tests: per-tool formatters + multi-card aggregation + resolver priority composition + idle fallback).
