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
