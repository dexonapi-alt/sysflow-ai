# Server hardening + error-source distinction

- **Created:** 2026-05-16
- **Status:** in-progress
- **Scope:** Stop the sysflow server from leaking infrastructure errors into the agent's recovery flow as if they were user-app errors. Stop the DB from crashing on null tool names. Stop the cli from retrying non-recoverable errors. Closes the user-reported sequence where (a) the agent emitted a `▸ unknown {}` tool call, (b) the server crashed with a Postgres NOT NULL constraint violation, (c) the cli retried the 500 three times, then (d) an OpenRouter "out of credits" error caused the agent to attempt writing `server/.env` IN THE USER'S PROJECT DIRECTORY trying to fix sysflow's own backend.

## Goal

User report (2026-05-16) — three distinct failure modes that all reduce to *"the server confuses its own infrastructure with the user's machine"*:

1. **DB crash on null tool name:**
   ```
   ✖ Server error 500: {"status":"failed","error":"null value in column \"tool\" of relation \"tool_results\" violates not-null constraint"}
   ```
   Agent emitted `▸ unknown {}` (a tool call with no name). Server's `saveToolResult` didn't validate, the row hit Postgres, NOT NULL violation, request died.

2. **Sysflow's OpenRouter credit-exhaustion presented as user-side fixable:**
   ```
   ✖ OpenRouter is out of credits and even the lowest affordable max_tokens would be too small to be useful.
   Top up at https://openrouter.ai/settings/credits, switch model with /model gemini-flash, or set GEMINI_API_KEY in server/.env
   ```
   Agent's error-reasoning chain interpreted the *"set GEMINI_API_KEY in server/.env"* sentence as a fix it could perform → tried to `write_file` against `server/.env` in the USER's project directory (`C:\Users\DevAPI\Documents\test\server\.env`). User saw a permission-denied loop. The agent literally tried to mutate sysflow's own backend config from inside a user app.

3. **Cli retried non-retryable 5xx + retried 402 with explicit "non-recoverable" semantics:**
   - `500 not-null constraint` retried 3× before giving up — the body was diagnostic-grade ("schema violation"), not transient.
   - `402 with "even the lowest affordable max_tokens would be too small"` retried 5× even though the error message itself says recovery is impossible.

The user's verbatim framing:

> *"BRUHH this is in the server problem likely related to api keys but it reflected in the users app which its not even related because this is our own server lol not the user but it treat it the user like the our server because of the output error lol it didn't distinguish that that's our server problem not the user machine error"*

End state — for the same trigger sequence:

- Agent emits a tool call with no name → cli rejects client-side with a synthetic `validation_failure` result; nothing reaches the server. If somehow it does, server validates the tool name before insert and returns 400 (not 500).
- OpenRouter returns 402 → server tags the error envelope with `errorSource: "sysflow_infra"`. The CLI prints *"sysflow's API quota is exhausted — switch model with `/model gemini-flash` or top up. Halting."* and **STOPS**. No agent recovery attempt. No retry.
- Cli sees `500 + non-retryable-body-signature` (constraint violations, unique-key conflicts, validation errors) → terminal failure with clean error; no retry.
- OpenRouter 402 with "too small" in body → terminal, no retry across the 5× loop.

## Context from knowledge base

- `decisions.md: ## System-level enforcement beats prompt-level guidance for free models` — load-bearing for Stage 1's mechanical tool-name rejection.
- `decisions.md: ## 0-hit web search is a recovery situation, not a success` — the inverse: some errors are NOT recoverable. Stage 2 establishes the corresponding rule for sysflow-infra failures.
- `architecture.md: ## Forced error reasoning + recovery` — the recovery chain. This plan adds an early-exit when `errorSource === "sysflow_infra"`.
- `applied/2026-05-15-forced-error-reasoning-and-recovery.md` Stage 4 — the ack-rejection loop. Stage 1 of this plan ensures the loop never fires for sysflow-infra errors (those should halt, not retry).

## Affected files

### Stage 1 — Reject null/unknown tool names client-side + server-side

- `cli-client/src/agent/executor.ts` — `dispatchTool` (or whatever the entry function is). Before sending the tool result to the server, validate `tool` is a string in the known-tool registry. If not, return a synthetic `validation_failure` result with `_errorCategory: "unknown_tool"` + an error string telling the agent to use a known tool name.
- `cli-client/src/agent/tools.ts` or `tool-meta.ts` — export `KNOWN_TOOL_NAMES: Set<string>` so the validator has a single source of truth.
- `cli-client/src/cli/render.ts` (the `formatToolLabel` default case at line ~127) — when tool name is unknown, render `▸ <invalid tool>` not `▸ unknown {}` (clearer signal in the cli output that something's wrong).
- `server/src/store/tool-results.ts` — `saveToolResult()` validates `tool` is a non-empty string. Returns early (logs a warning, does not throw) when null/empty so the request still completes with a clean 400 envelope.
- `server/src/handlers/tool-result.ts` — early in `handleToolResult`, reject body with `tool == null` AND `(!toolResults || toolResults.length === 0)` — return `{ status: "failed", error: "Tool name required", errorCode: "validation_failure", errorSource: "user_machine" }`.
- 8 new tests covering: client-side reject for unknown tool; server-side reject for null tool; render-side label change; saveToolResult guard.

### Stage 2 — `errorSource` discriminator on all error envelopes

- `server/src/types.ts: ClientResponse` — add `errorSource?: "sysflow_infra" | "user_machine" | "unknown"`. Three values:
  - `"sysflow_infra"` — server's own API quota / DB connection / OpenRouter credits / Anthropic 401 / Gemini auth — failures **inside sysflow itself**. Terminal: user must take action on sysflow side (top up, switch model, set env var).
  - `"user_machine"` — tool execution failure on the user's machine (file not found, permission denied, command not found). Recoverable: agent retries or pivots.
  - `"unknown"` — fallback. Default for legacy paths; treated as user_machine.
- `server/src/providers/openrouter.ts` — when a 402 / 401 / quota error fires, tag the error response with `errorSource: "sysflow_infra"`.
- `server/src/providers/anthropic.ts` / `gemini.ts` — same for their auth / quota errors.
- `server/src/handlers/tool-result.ts` — when `errorSource === "sysflow_infra"`, **skip the error-reasoning chain entirely**. Don't recover; surface terminally. The chain's recovery hints are for user_machine errors only.
- `cli-client/src/lib/server.ts` — on response with `errorSource === "sysflow_infra"`, the cli renders a banner: `═══ SYSFLOW INFRASTRUCTURE ERROR ═══\n<error>\n\nThis is a sysflow / provider issue — not a problem with your project. Take the suggested action and re-run.\n═══`. Run terminates cleanly.
- 8 new tests covering envelope tagging on each provider's quota error, handler short-circuit, cli render.

### Stage 3 — Cli retry classifier: non-retryable 5xx

- `cli-client/src/lib/server.ts` — `callServer` retry loop. Currently retries on `status === 429`. Add: parse 5xx body for **non-retryable signatures**:
  - `"not-null constraint"`, `"unique constraint"`, `"foreign key violation"`, `"check constraint"` → Postgres schema violations
  - `"ValidationError"`, `"validation_failure"`, `"invalid_payload"` → application validation
  - `"errorSource":"sysflow_infra"` → already-classified terminal failure
- On match → throw immediately, no retry. Surface a clean error to the user.
- Transient 5xx (no body / "Internal Server Error" generic / network-level) → retry as today (up to N times).
- 6 new tests covering each non-retryable signature + transient retry preserved.

### Stage 4 — OpenRouter 402 "too small" → terminal, no retry

- `server/src/providers/openrouter.ts` — 402 retry logic (lines ~116-125 per investigation). Currently retries while `affordable > 512`. Add a check: if error body contains `"too small to be useful"` OR `"even the lowest"` OR `"insufficient credits"`, mark terminal + return immediately with `errorSource: "sysflow_infra"`. No retry.
- Also: the adapter's fallback chain (`adapter.ts`) — when a provider returns `errorSource: "sysflow_infra"`, skip remaining fallback providers if they share the same root cause (e.g., all OpenRouter models share the same credit pool — falling to another OpenRouter model won't help).
- 4 new tests.

### Stage 5 — Telemetry + KB + plan archive

- `cli-client/src/agent/usage-log.ts` — `RunSummary` gains:
  - `sysflowInfraErrorCount: number` (per-run count of sysflow_infra errors — spike = your API keys / quotas are draining)
  - `nullToolRejectionCount: number` (per-run count of client-side unknown-tool rejections — spike = LLM hallucinating tool names)
  - `nonRetryable5xxCount: number` (per-run count of 5xx errors the cli refused to retry)
- KB:
  - `architecture.md: ## Error provenance (sysflow_infra vs user_machine)` — diagram of the classification + which paths each value gates.
  - `decisions.md: ## Sysflow infra errors halt the agent — they're not user-machine bugs` — rationale + the user's repro.
  - `decisions.md: ## Cli refuses to retry 5xx with diagnostic bodies` — why string-pattern non-retryable detection is the right level (not exhaustive HTTP semantics).
  - `gotchas.md: ## Agent tried to write server/.env in user project to fix sysflow's OpenRouter credits` — the canonical repro.
- Plan archived to `applied/`.

## Migrations / data

None at the schema level. The Stage 1 server-side guard prevents bad inserts but doesn't change the table.

## Hooks / skills / settings to update

- `quality.null_tool_rejection_enabled` (bool, default `true`) — Stage 1 kill switch
- `quality.sysflow_infra_terminal_enabled` (bool, default `true`) — Stage 2 kill switch (turn off to fall back to today's chain-tries-everything behaviour)
- `quality.non_retryable_5xx_detection_enabled` (bool, default `true`) — Stage 3 kill switch

## Dependencies

- No new packages. Stage 3's body-signature detection is pure string match.

## Risks & mitigations

- **False positive on non-retryable 5xx — a transient PG hiccup mentioning "constraint" in a stack trace gets classified terminal.** Mitigation: match against the canonical PG error message format (which always includes `"violates ... constraint"`), not bare `"constraint"`. Tests cover this.
- **`sysflow_infra` mis-classification swallows a legitimately user-fixable error.** Mitigation: only well-known providers (OpenRouter, Anthropic, Gemini) tag with `sysflow_infra`. User-machine tool errors (file_not_found, permission, network, etc.) keep their existing classification path. Conservative default.
- **The agent learns to "expect" sysflow_infra halts and stops trying recovery on legitimate user-machine errors.** Mitigation: the discriminator is on the error ENVELOPE, not in the reasoning chain's prompt; the agent only sees the recovery hint (which we already have for user_machine via Stage 3 of forced-error-reasoning). It doesn't see the sysflow_infra path because that path SHORT-CIRCUITS the chain.
- **Cli render of the sysflow-infra banner is too aggressive (user has a brittle terminal).** Mitigation: it's a single block of text, no animation, no Ink mount. Fallback to plain `console.log` when Ink isn't active.

## Implementation order

1. **Stage 1 — null/unknown tool rejection (client + server).** Most user-impact: eliminates the 500-crash in the user's repro. *(One PR.)*
2. **Stage 2 — `errorSource` discriminator.** The architectural change everything else composes against. *(One PR.)*
3. **Stage 3 — Cli retry classifier.** Quick win once Stage 2 lands (the `sysflow_infra` tag is one of the signatures). *(One PR.)*
4. **Stage 4 — OpenRouter 402 "too small" terminal.** Narrow fix in one provider. *(One PR.)*
5. **Stage 5 — Telemetry + KB + plan archive.** *(One PR.)*

Each stage = one PR off `main`. ~1,200 LOC + 26-30 new tests across five stages.

## Verification

**Stage 1**

- Unit: cli `dispatchTool` rejects unknown tool names with synthetic result; server `saveToolResult` returns early on null tool; handler returns 400 envelope on missing tool.
- Manual: force the agent to emit a hallucinated tool name (test harness) — observe cli short-circuits without server contact.

**Stage 2**

- Unit: each provider's quota / auth error path produces `errorSource: "sysflow_infra"`. Handler skips recovery chain for sysflow_infra. Cli renders the banner.
- Manual: temporarily set `OPENROUTER_API_KEY` to invalid value — observe the run halts cleanly with the banner, no agent recovery attempt.

**Stage 3**

- Unit: each non-retryable signature triggers immediate throw; transient 5xx still retries.
- Manual: simulate a 500 with `"not-null constraint"` body — observe one attempt, then terminal.

**Stage 4**

- Unit: `"too small"` in error body → no retry; `affordable > 512` still retries.
- Manual: force OpenRouter into a near-empty credit state — observe single failure, no 5× retry loop.

**Stage 5**

- Telemetry: counters populate per-run. KB entries lint clean. Test suites green.

## Out of scope

- **Auto-switching models on sysflow_infra failures** (e.g. OpenRouter exhausted → auto-fall to Gemini). The user should pick; auto-fallback was specifically rolled back by the prior `model-lock-and-portable-reasoning` plan because it confused users.
- **Persistent error reporting / status page.** Beyond scope; telemetry counters cover the diagnostic need.
- **Retrying with exponential backoff on legitimate transient 5xx.** Current linear retry stays; Stage 3 only adds non-retryable detection.
- **Database schema changes.** Stage 1 prevents the bad insert at the application level; the schema constraint that's enforcing NOT NULL is correct.

## Composition with existing systems

- **Forced-error-reasoning Stage 4 ack-rejection loop** — Stage 2's `errorSource: "sysflow_infra"` short-circuit ensures the ack-loop never fires for sysflow infra errors (would never recover; would burn budget and end with the same halt).
- **Project-init reasoning** — independent. Project-init reads the user's directory; sysflow_infra errors are about the server's own state.
- **Cli retry budget** — Stage 3's non-retryable classifier sits BEFORE the existing retry-budget logic; saves budget for legitimately transient failures.
