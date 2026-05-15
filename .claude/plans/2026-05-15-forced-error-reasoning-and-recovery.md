# Forced error reasoning + persistent error memory + recovery

- **Created:** 2026-05-15
- **Status:** draft
- **Scope:** Make the agent **stop, reason about, and address every tool error** before proceeding. Today's `on_error` pipeline (Phase 5) fires a Flash brief but the main model often skims past it and moves to the next step without acknowledging the failure. This plan layers four overlapping nets: iterative paragraph error-reasoner (replaces the structured bug-brief shape), mandatory error-acknowledgement injection (forces the next prompt to address the error), error-pattern memory (recalls past fixes for similar errors), and server-side rejection of responses that ignore the error.

## Goal

User-reported failure mode (2026-05-15):

> *"when it receives error the llm is so inconsistent it just proceed to the next thing he do without realizing he made an error, and it doesn't even try to reason it out, and doesn't even try to fix the command, it just go to the next step without realizing there's an error."*

Concrete observed example: `ls -R` failed on Windows (cmd.exe doesn't know `ls`). The agent's next move was a web search for *"tsconfig.json configuration 2026"* — entirely unrelated, no acknowledgement of the failure, no attempted Windows-equivalent (`dir`, `Get-ChildItem`). The error was visible in the tool-result the agent received; it just didn't engage with it.

The root issue is the same as the broader thread in the codebase: **prompts that say *"please reason about errors"* get ignored when models are confused**. The fix has to be system-level enforcement — the same INJECT / REJECT / FORCE pattern Phase 11 awareness + Stage 1 verify-after-write + Stage 3 mandatory self-review used.

End state for an error turn:

1. **Tool error fires** (stderr / non-zero exit / failed write).
2. **Error-reasoning chain runs** — Flash iterative paragraphs, same self-directing-depth pattern as `runIterativeChain` for preflight. Produces `{ rootCause, platformContext, alternativeCommands[], confidence }`.
3. **Error-pattern memory recall** — checks `.sysflow-memory.md` for prior entries matching the error class. If a fix worked before, surfaces it.
4. **Forced `═══ ERROR — REASON THROUGH THIS ═══` block** injected into the next tool-result message. Tells the agent: read this error, reason about it in `reasoningChain[]`, propose a fix BEFORE next action.
5. **Server-side rejection** — if the next response doesn't reference the error in its `reasoningChain` AND doesn't pivot away from the broken approach, reject with a corrected prompt forcing the redo.
6. **Memory commit** — when the agent's NEXT action succeeds, record an `error_pattern` memory entry: error + platform + what worked. Next similar error short-circuits to that fix.

## Context from knowledge base

- `architecture.md: ## Awareness loop (Phase 11)` — three-signal awareness loop already catches *repeated* errors via `same_file_edited_repeatedly` + `repeated_tool_error`. After this plan, error reasoning fires on the FIRST error — Phase 11 stays as the second-line defence for sustained drift.
- `architecture.md: ## LLM-driven intent classification` — the same iterative-paragraph-chain pattern is reused here. Each iteration produces ONE senior-engineer paragraph + a `done` flag the LLM raises when ready to commit.
- `architecture.md: ## Active memory loop (Phase 15)` — the `applyMemoryFeedback` confirmation/contradiction mechanism. New `error_pattern` kind plugs into the same recorder + recall infrastructure.
- `decisions.md: ## System-level enforcement beats prompt-level guidance for free models` — the load-bearing insight: forcing the agent to acknowledge the error via INJECTION + REJECTION is the only reliable mechanism on free-tier.
- `decisions.md: ## Paragraph chain for deliberation, structured form for concrete artifacts` — the existing `bugBrief` (`symptom / suspectedBoundary / proposedFix`) is the WRONG shape for live error recovery; a paragraph chain is. Structured fields stay for downstream code that consumes them (divergence detector).
- `decisions.md: ## Why LLM intent classification beats regex + what the fallback looks like` — informs the fallback rule. If the error-reasoning chain returns null (no backend / parse fail), the existing on_error bug brief stays as the safety net.
- `gotchas.md: ## run_command on Windows hit cmd.exe, breaking every bash-form alias the LLM emits` — the immediate trigger for this plan. PR #87 fixed the shell-layer bug, but the agent's recovery behaviour on ANY error (not just `ls`) is the systemic concern.
- `applied/2026-05-15-free-tier-quality-enforcement.md` — Stage 1's verify-after-write injection + Stage 3's mandatory self-review are the proven INJECT patterns this plan extends.

## Affected files

### Stage 1 — Error-reasoning iterative chain (replaces bug-brief structured shape for on_error)

- `server/src/reasoning/pipelines/error-reasoning-pipeline.ts` (NEW) — system prompt for the iterative error reasoner. Senior-engineer rubric adapted for error analysis:
  1. **What happened** — quote the exact error / stderr / exit code.
  2. **Why** — root cause hypothesis (platform / tool / argument / state).
  3. **Platform context** — the run's OS + shell. Is the error platform-specific (Windows-only / Unix-only)?
  4. **Alternatives** — list 2-3 concrete commands or approaches that would work.
  5. **Best next move** — pick one and explain why.
  6. **Decide** — `done: true` with `recommendedCommand` + `alternatives[]`, OR `done: false` with the specific follow-up question.
- `server/src/reasoning/pipelines/index.ts` — register `error_reasoning` as a PipelineKind.
- `server/src/reasoning/intent-classifier.ts` (or a new `error-reasoner.ts`) — orchestrator `runErrorReasoningChain(payload, callBackend?)` mirroring `classifyIntentByChain`. Max 4 iterations cap (errors are usually less ambiguous than intent).
- Schema: `errorReasoningStepSchema` + `errorReasoningBriefSchema` (per-iteration + final). Final brief shape:
  ```ts
  {
    kind: "error_reasoning",
    paragraphs: string[],            // senior-engineer chain (surfaces in <ReasoningPeek>)
    rootCause: string,               // e.g. "Windows cmd.exe doesn't know `ls`"
    platformContext: string,         // e.g. "win32 / powershell"
    alternativeCommands: string[],   // concrete commands the agent should try
    recommendedCommand: string,      // the one to try first
    confidence: "HIGH" | "MEDIUM" | "LOW"
  }
  ```

### Stage 2 — Platform context surfacing

- `server/src/providers/prompt/sections/env-info.ts` already emits OS/shell. Stage 2 ensures the error-reasoning user turn carries:
  - `process.platform` value
  - The actual SHELL that ran the failed command (PowerShell / sh / cmd if legacy)
  - Project-level cues (presence of `package.json`, `pyproject.toml`, etc.) — helps the reasoner know what alternatives are available.
- `server/src/handlers/tool-result.ts` — the `on_error` block builds the user turn with platform context inline (no new util needed; just thread the existing env-info).

### Stage 3 — Mandatory `═══ ERROR — REASON THROUGH THIS ═══` injection

The Stage 1 verify-after-write pattern, adapted. After every tool error:

- `server/src/services/error-reason-block.ts` (NEW) — pure helper `buildErrorReasoningBlock({ error, brief })` that renders:
  ```
  ═══ ERROR — REASON THROUGH THIS ═══

  The previous tool call FAILED. Before doing anything else:

  1. In your `reasoningChain[]`, acknowledge the failure explicitly.
     Quote the exact error text.
  2. Reason about WHY it failed. Was it a platform issue, a missing
     dependency, a wrong argument? Use the platform context below.
  3. Pick ONE of the alternatives the reasoner suggested (or your
     own if better). Explain WHY this one will work.
  4. Then issue the corrected tool call.

  ERROR: <stderr / message / exit code>
  ROOT CAUSE (reasoner): <brief.rootCause>
  PLATFORM: <brief.platformContext>
  RECOMMENDED: <brief.recommendedCommand>
  ALTERNATIVES: <brief.alternativeCommands joined>

  Do NOT proceed past this error without addressing it. Do NOT
  switch topics (web search, unrelated file reads) — that's the
  failure mode this block exists to prevent.
  ═══ END ERROR ═══
  ```
- `server/src/providers/base-provider.ts: buildToolResultMessage` — new protected step `renderErrorReasoningBlock(payload, lastError)` called when any tool result in this batch carries an error. Sits AFTER the existing verify-after-write block, BEFORE the chunk plan section, so it's the LAST thing the model reads before its next response.
- `server/src/services/flags.ts` — `quality.force_error_reasoning_enabled` (default `true`). Kill switch if the block over-fires (e.g. on benign warnings).

### Stage 4 — Server-side rejection when the response ignores the error

The Stage 3 mandatory-self-review pattern, adapted. The next response after an error MUST address it.

- `server/src/services/error-acknowledgement-guard.ts` (NEW) — pure validator `validateErrorAcknowledgement({ priorError, response, brief })`. Checks:
  - Does `response.reasoningChain` (or its prose equivalent) MENTION the error? — token-overlap heuristic against the error text + reasoner's `rootCause`.
  - Did the agent change approach? — the next tool call shouldn't be the same `(tool, args)` as the failed one (that's the existing `same_action_repeated_in_session` heuristic, but at the response-validation layer it's a hard block, not a soft signal).
  - If neither check passes → return `{ ok: false, reason: "..." }`.
- `server/src/handlers/tool-result.ts` — when the validator returns `ok: false`, the handler injects a stronger reject + retry prompt: *"Your previous response did NOT address the error from the prior tool call. STOP. Read the error block again. Acknowledge it in `reasoningChain`. Pivot."* Per-run rejection cap (3) prevents infinite loops.
- Same cap mechanism as `MAX_COMPLETION_REJECTIONS` in tool-result.ts today.

### Stage 5 — Error-pattern memory

- `server/src/memory-store/kinds.ts` (or wherever memory kinds are defined) — new entry kind `error_pattern`. Shape:
  ```ts
  {
    kind: "error_pattern",
    id: <sha256-derived>,
    content: <natural language description>,
    metadata: {
      errorClass: string,       // e.g. "command_not_found"
      errorSignature: string,   // truncated stderr to match against
      platform: string,         // win32 / linux / darwin
      failedCommand: string,
      workingCommand: string,
      // standard timestamps + counters from Phase 8
    }
  }
  ```
- `server/src/memory-store/recorders.ts` — `recordErrorPattern({ cwd, error, platform, failedCommand, workingCommand, runId })`. Fires AFTER an error → reasoner → retry → SUCCESS sequence (i.e. the agent recovered).
- `server/src/memory-store/recall.ts` — `recallErrorPatterns(cwd, errorSignature, platform)`. Returns top-N matching entries by signature similarity + recency.
- `server/src/handlers/tool-result.ts` — on every error, recall matching patterns BEFORE running the error reasoner. If a HIGH-confidence match exists, prepend it to the reasoner's context: *"You hit this same error before; last time `X` worked instead."* The reasoner then either confirms the prior fix or revises.

### Stage 6 — Telemetry + KB + plan archive

- `cli-client/src/agent/usage-log.ts` — `RunSummary.errorReasoningEvents` counter (per-run count of error-reasoner invocations). `RunSummary.errorAcknowledgementRejections` counter.
- `server/src/types.ts: ClientResponse` — gain `errorReasoningParagraphs?: string[]` (chain paragraphs surfaced for `<ReasoningPeek>` via the existing reasoning_brief event path).
- `architecture.md: ## Forced error reasoning + recovery` — diagram + flow + the four-net composition.
- `decisions.md: ## Why error reasoning is iterative + structured fields stay for downstream code` — the rejected alternatives: single-shot LLM, retry-with-same-prompt, structured-only bug brief.
- `gotchas.md` — entry for any edge case the implementation surfaces.
- Plan archived to `applied/`.

## Migrations / data

`error_pattern` is a new memory entry kind. The `.sysflow-memory.md` file format already supports arbitrary kinds (Phase 8); no migration needed. Existing entries are untouched.

## Hooks / skills / settings to update

- New flags:
  - `quality.force_error_reasoning_enabled` (bool, default `true`) — Stage 3 inject kill switch.
  - `quality.error_acknowledgement_rejection_enabled` (bool, default `true`) — Stage 4 rejection kill switch.
  - `reasoning.error_reasoning_max_iterations` (number, default `4`) — chain depth cap.
  - `memory.error_pattern_recall_enabled` (bool, default `true`) — Stage 5 recall kill switch.
- No `.claude/hooks/` changes. No skill changes.

## Dependencies

- No new npm packages.
- Reuses `pickReasonerBackend` for the error reasoner (free / Gemini / Anthropic / OpenRouter — same backend the preflight uses).
- Reuses the iterative-chain pattern from `classifyIntentByChain` (PR #84). The orchestrator is a near-copy; the prompt + schema differ.

## Risks & mitigations

- **The error block fires on benign warnings (lint warning, deprecation notice).** Mitigation: only trigger on `error` / `stderr` content that classifies as actual failure (the existing `classifyToolErrorFromResult` is the gate). Warnings that include `[BENIGN]` / `WARN:` prefixes skip the block.
- **The error reasoner adds latency on every error.** Mitigation: per-run cache the FIRST reasoner call per `(tool, errorSignature)` tuple. If the same error fires twice in a row, the second hit skips the LLM and reuses the prior brief.
- **Server-side rejection loops infinitely if the agent never acknowledges.** Mitigation: hard cap at 3 rejections per run (matches `MAX_COMPLETION_REJECTIONS`). After the cap, the rejection block downgrades to a SOFT signal in the divergence tracker — the awareness loop takes over.
- **Memory recall surfaces a STALE error_pattern (the working command is now broken because of an env change).** Mitigation: the Phase 15 contradiction loop applies — if the recalled fix fails on retry, the memory's `contradictionCount` increments and the entry retires after 2 strikes. Same shape as other memory kinds.
- **Free-tier rate limit hit by error reasoner.** Mitigation: same per-run cache + per-error cache. Free-tier overhead: ~1 extra Flash call per UNIQUE error per run.
- **The user's prompt LITERALLY asks the agent to ignore the error ("just continue past this").** Mitigation: server-side rejection is the soft "you should address this" — it's not a hard veto. After 3 rejections the system falls back to letting the agent proceed. User override is via re-prompt or `/continue`.
- **The reasoner suggests a wrong alternative.** Mitigation: confidence-aware framing. HIGH-confidence picks render as `RECOMMENDED:`; MEDIUM/LOW renders as `OPTIONS:` so the agent doesn't trust them as gospel. Wrong alternatives that the agent tries + that ALSO fail then trigger another error-reasoner pass (with the failed alternative in context).

## Implementation order

1. **Stage 1 — Error-reasoning iterative chain.** Foundation: new pipeline + schema + orchestrator + unit tests. Not wired yet. Smallest blast radius — pure additive code. *(One PR.)*
2. **Stage 2 — Platform context surfacing.** Tiny — extends the user turn the orchestrator builds. *(Folded into the Stage 1 PR.)*
3. **Stage 3 — Mandatory injection block.** Wires the orchestrator into `tool-result.ts`'s `on_error` path. Adds the inject block to `base-provider.ts`'s message builder. New flag. *(One PR.)*
4. **Stage 4 — Server-side rejection.** Adds the acknowledgement guard + retry loop with rejection cap. New flag. *(One PR — landed after Stage 3 telemetry confirms the inject is working.)*
5. **Stage 5 — Error-pattern memory.** Adds the new memory kind + recorder + recall. Recall threads into Stage 1's user turn so the reasoner sees prior fixes. *(One PR.)*
6. **Stage 6 — Telemetry + KB + plan archive.** Two RunSummary counters + ClientResponse field + two KB entries + plan flip. *(One PR.)*

Each stage = one PR off `main`. Stage labels: `feat(reasoning): Stage 1 — error reasoning chain`, etc.

## Verification

**Stage 1**
- Unit: `parseErrorReasoningStep` parses well-formed iterations; rejects malformed; supports `done: true | false`.
- Unit: orchestrator commits on `done: true`; runs to cap with last hypothesis when LLM never commits; falls back gracefully on chain failure.
- Manual: stub the chain with a fixture brief, observe the brief shape.

**Stage 2**
- Unit: user turn includes `PLATFORM:` line + the run's actual `process.platform`.
- Manual: trigger an `ls -R` failure on Windows (post-PR-#87 still relevant for testing the brief's content) — observe the brief's `platformContext === "win32"` and `recommendedCommand` references a Windows-equivalent.

**Stage 3**
- Unit: `buildErrorReasoningBlock` returns the expected markdown shape with the brief's fields filled in.
- Unit: `renderErrorReasoningBlock` returns empty string when the tool result has no error, the expected block when it does.
- Manual: deliberately fail a `run_command` — observe the `═══ ERROR — REASON THROUGH THIS ═══` block in the next tool-result message body (visible in server logs).

**Stage 4**
- Unit: `validateErrorAcknowledgement` returns `ok: false` when the response's reasoningChain doesn't mention the error AND issues the same broken command; `ok: true` when the chain mentions the error OR a different command is issued.
- Unit: rejection cap caps at 3.
- Manual: deliberately make the agent ignore an error (e.g. force-stub the LLM response) — observe the rejection + retry prompt; after 3, observe the soft signal in divergence tracker.

**Stage 5**
- Unit: `recordErrorPattern` writes to `.sysflow-memory.md`; `recallErrorPatterns` returns matching entries by signature similarity.
- Manual: trigger `ls -R` failure, observe the agent recovers with `dir`, observe a new `error_pattern` entry in `.sysflow-memory.md`. Re-run a similar failure — observe the recall surfaces the prior pattern in the next reasoner's context.

**Stage 6**
- Telemetry: `errorReasoningEvents` and `errorAcknowledgementRejections` populate per-run in `usage.jsonl`.
- `<ReasoningPeek>` surfaces the error reasoner's paragraphs via the existing reasoning_brief event with `kind: "error_reasoning"` — no new renderer needed (the plain-prose render path from PR #83 handles it).
- All KB entries lint cleanly.
- `npm test` + `npm run typecheck` green across both workspaces.

## Out of scope

- **Auto-executing the recommended alternative** without the model's agreement. The reasoner suggests; the model decides. Stage 4's rejection is a soft pressure, not a hard substitution. Removing model agency on retries is too risky for v1 — the LLM may have context the reasoner missed.
- **Cross-run error recall** (carrying error_patterns across `/continue`). The Phase 8 memory already supports this for other kinds; `error_pattern` will inherit the same behaviour for free. No special handling needed.
- **Refactoring the existing on_error bug pipeline.** It stays as the fallback when the iterative chain returns null. Same shape as PR #84's regex fallback for intent classification.
- **Adding error-class taxonomies beyond what `tool-error-classifier.ts` already has.** The classifier is the input to the reasoner's user turn; we use what's there. Expanding the taxonomy is a future plan if telemetry shows the reasoner often misses the error class.
- **A user-visible "skip error reasoning" hotkey.** The flag system + `/continue` cover the off-switch case for power users.

## Composition with existing systems

- **Phase 11 awareness** still fires `repeated_tool_error` and `same_action_repeated_in_session` heuristics. Stage 4's rejection catches the FIRST instance; the awareness signals catch sustained drift. Both signals feed the same confidence tracker.
- **Phase 16 chained reasoning** (`runReasoningChain`) is the orchestrator pattern. Error reasoning is one more concern that chains within itself, peers across other concerns.
- **PR #87 Windows-shell fix** is the immediate trigger for this plan — but the plan addresses the systemic LLM behaviour, not just `ls -R`. After this plan: any error (npm install failure, write_file permission denied, typecheck failure, missing file, network timeout) gets the same forced-reasoning treatment.
- **Stage 4 of free-tier-quality-enforcement** (per-step divergence) catches stuck loops. This plan catches the FIRST error before it becomes a loop.
- **Intent classification chain (PR #84-#86)** — same iterative-paragraph-chain pattern. Error reasoning is the third concrete use case (after preflight + intent); the pattern is becoming the canonical shape for *"think before you act"*.

## Notes for implementation

The user's exact framing was:

> *"we need a reasoner when receiving an error it reason why and end to end, and find out the reason, for example the user machine doesnt support ls becuase its windows terminal and doesnt support the command. and one thing i found out is that when it recives error the llm is so inconsistent it just proceed to the next thing he do without realizing he made an error, and it doesnt even try to reason it out, and doesnt even try to fix the command, it just go to the next step without realizing there's an error. we need to plan this. we need memory + reasoning + error awareness + ur recommended steps"*

Four asks, all addressed:

- **Memory** → Stage 5 `error_pattern` kind + recall on next similar error
- **Reasoning** → Stage 1+2 iterative paragraph chain with platform context, replacing the structured bug-brief shape for live recovery
- **Error awareness** → Stage 3 mandatory injection block forcing the agent to ACKNOWLEDGE the error before next action
- **Recommended steps** → the six-stage implementation order above, in dependency sequence; each stage = one PR.

The systemic principle (per `decisions.md: ## System-level enforcement beats prompt-level guidance for free models`) drives every stage: telling the agent *"please reason about errors"* in the system prompt doesn't work on free-tier models. Forcing the reasoner to run, injecting the result, rejecting non-acknowledgement, and recording the fix for next time are the mechanical fixes.
