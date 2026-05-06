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
