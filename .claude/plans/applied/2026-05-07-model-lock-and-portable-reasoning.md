# Model lock-in, portable reasoner, and brief enforcement

- **Created:** 2026-05-07
- **Status:** implemented (2026-05-15)
- **Scope:** Three user-flagged issues that must land before Phase 17. Lock the user's chosen model so it never silently swaps to a different provider. Wire the reasoning briefs into Anthropic + OpenRouter system prompts so the briefs aren't Gemini-only. Make the reasoner backend pluggable so non-Gemini main models stay reasoning-capable when Gemini is unavailable. Strengthen brief framing so the main model honours it instead of glancing at it.

## Goal

Three distinct symptoms reported by the user across the last few sessions, all rooted in three architectural gaps:

1. *"i used claude sonnet why it switches to gemini lol"* — `MODEL_FALLBACK_CHAINS` at `server/src/providers/base-provider.ts:235-244` silently swaps the user's explicit pick to a different provider on rate-limit. The user's chosen model is supposed to be honoured.
2. *"the model reasoning didn't applied or understood what he reason it just proceed to the task without understanding its own reason"* — preflight / bug / decision / summary briefs render with the soft framing *"Trust this brief unless tool results contradict it"* (`server/src/providers/prompt/sections/reasoning-brief.ts:126`). Worse, **Anthropic and OpenRouter don't even include this section in their system prompts** — they call `this.systemPrompt` (the static `SHARED_SYSTEM_PROMPT`) instead of the context-aware `getSystemPrompt(ctx)`. So when the user picks claude-sonnet, the reasoner runs, the brief is generated, the brief is *cached*, and then claude never sees it.
3. *"currently its only gemini have that reasoning and all other systems, we need all models to have all system gemini have"* — the reasoner backend is hardcoded to `gemini-2.5-flash` at `server/src/reasoning/task-reasoner.ts:171`. If `GEMINI_API_KEY` is missing or IP-blocked, every Phase 5/10/11/15/16 system silently degrades for *every* main model — even when the user has a working ANTHROPIC_API_KEY or OPENROUTER_API_KEY.

After this plan: choosing claude-sonnet uses claude-sonnet end-to-end with claude-haiku as its reasoner; choosing gemini-flash continues to use Gemini Flash for both; the briefs reach all main-model system prompts with directive framing; rate-limited paid models surface a clear error instead of an invisible switch.

## Context from knowledge base

- `architecture.md: ## Chunked reasoning loop (Phase 10)` — the loop's existing degradation path on missing `GEMINI_API_KEY` (handlers fall back to legacy single-turn). After this plan, that degradation only fires when the user truly has no reasoner backend at all, not just when Gemini is down.
- `architecture.md: ## Free-tier policy + chained reasoning (Phase 16)` — `free-tier-policy.ts` is the central module for free-tier gates. The new reasoner-backend selector belongs in the same module (per the existing decision *Free-tier policy is a centralised module*).
- `decisions.md: ## Free-tier policy is a centralised module, not scattered checks` — drives the decision to put `pickReasonerBackend(mainModel)` in `free-tier-policy.ts`, not scattered `if (mainModel === "claude-...")` checks.
- `decisions.md: ## Chain WITHIN a concern, peer ACROSS concerns` — informs the "lock-in vs fallback" tradeoff. Cross-provider fallback is mixing concerns: rate-limit recovery should retry the SAME provider, not switch backends.
- `gotchas.md: ## Free-tier OpenRouter affordability ceiling is ~15k tokens` — the only legitimate cross-provider fallback case in the codebase. After this plan, that path is preserved (openrouter-auto stays in `MODEL_FALLBACK_CHAINS`); explicit picks (claude-*, gemini-flash) are removed.
- `applied/2026-05-07-phase-16-deep-reasoning-on-free-models.md` — Phase 16 Stage 1's `free-tier-policy.ts` is the natural home for the new reasoner-backend helper. The `runReasoningChain` helper (Phase 16 Stage 2) is backend-agnostic; only `callReasoner()` itself needs to swap.

## Affected files

**Stage A — Provider lock-in**
- `server/src/providers/base-provider.ts` — empty out fallback chains for explicit single-provider picks (`claude-sonnet`, `claude-opus`, `gemini-flash`, `gemini-pro`, `swe`); keep `openrouter-auto`'s chain since it cycles through free models by design.
- `server/src/providers/adapter.ts` — emit a clear "model X is rate-limited, no fallback because lock-in is on" log + `failed` response with retry hint. No silent switch.
- `server/src/services/flags.ts` — register new flag `providers.lock_to_chosen_model` (default `true`).

**Stage B — Brief consumption in non-Gemini providers**
- `server/src/providers/anthropic.ts` — replace `system: this.systemPrompt` with `system: getSystemPrompt(ctx)` where `ctx` carries `reasoningBrief`, `reasoningElaborationBrief`, plus `cwd` / `model` / git-branch like Gemini already does. Same casts at the seam pattern.
- `server/src/providers/openrouter.ts` — replace `{ role: "system", content: this.systemPrompt }` with the ctx-aware system prompt; same pattern as Anthropic. Both fresh-conversation and continuation branches need the swap.
- `server/src/providers/gemini.ts` — read for reference; no changes (Gemini already does this).
- Unit test: assert each provider's first request body contains the brief section when `payload.reasoningBrief` is set.

**Stage C — Brief framing strength**
- `server/src/providers/prompt/sections/reasoning-brief.ts` — replace the soft trailer (`"Trust this brief unless tool results contradict it"`) with a directive frame mirroring chunk-plan's `═══ HONOUR EXACTLY ═══` style. Confidence-aware: `HIGH` confidence → `"YOU MUST FOLLOW THIS PLAN. The pre-flight reasoner classified the request with HIGH confidence."`; `MEDIUM` → `"FOLLOW THIS PLAN. Deviate only if a tool result proves a step impossible."`; `LOW` → keep the existing advisory tone (low confidence shouldn't be treated as binding). The confidence ladder already exists in the schema; we just route it.
- Add a one-line "what to do if the plan is wrong" escape hatch so the model isn't trapped: *"If the plan disagrees with what tool results reveal, surface the conflict in `reasoning` before deviating."*
- Unit test: snapshot the rendered section at HIGH/MEDIUM/LOW for each pipeline.

**Stage D — Pluggable reasoner backend**
- `server/src/reasoning/backends/` — new directory.
  - `gemini-backend.ts` — extracts the current `callReasoner` body. Same `gemini-2.5-flash` model, same prompt config.
  - `anthropic-backend.ts` — `claude-haiku-4-5`. Hits `/v1/messages` with the same system prompt + user-turn shape; `response_format` workaround is the same JSON-envelope-via-prompt trick the main Anthropic provider already uses.
  - `openrouter-backend.ts` — uses an OpenRouter free-tier reasoning model (e.g. `google/gemini-2.0-flash-exp:free`). Mirrors the OpenRouter main provider's auth + 402 handling.
  - `index.ts` — exports `callReasoner(payload, kind, backend)` that routes to the chosen backend.
- `server/src/services/free-tier-policy.ts` — new pure helper `pickReasonerBackend(mainModel: string): "gemini" | "anthropic" | "openrouter" | null`:
  - `claude-sonnet` / `claude-opus` → `"anthropic"` (Haiku is the cheapest claude reasoner)
  - `gemini-flash` / `gemini-pro` → `"gemini"`
  - `openrouter-auto` / `llama-70b` / `mistral-small` / `gemini-flash-or` → `"openrouter"` (or `"gemini"` if `GEMINI_API_KEY` is set; fall through to `"openrouter"` otherwise)
  - `swe` → `"gemini"` (existing behaviour)
  - returns `null` ONLY when no backend has its API key set — the caller treats `null` the same as today's "no GEMINI_API_KEY" path.
- `server/src/reasoning/task-reasoner.ts` — `callReasoner` becomes a thin dispatcher that calls `pickReasonerBackend(payload.model)` then routes to the chosen backend. The existing `callReasonerWithTimeout` wrapper (PR #62) stays — timeout is backend-agnostic.
- `server/src/services/flags.ts` — new flag `reasoning.backend` with default `"auto"` (let `pickReasonerBackend` decide). Operators can override to a specific backend if they need to pin one.
- `server/src/reasoning/__tests__/backends.test.ts` — for each backend, assert: API-key absent → returns null; API-key present + valid response → parses; API-key present + 429 → propagates as throw so existing retry budget catches it.

**Stage E — Tests, telemetry, knowledge entries**
- `cli-client/src/agent/usage-log.ts` — extend `RunSummary` with `reasonerBackend` (so telemetry shows which backend served the run's Flash calls).
- `server/src/reasoning/__tests__/task-reasoner-backend-routing.test.ts` — table-driven: each main-model ID maps to the expected backend.
- `server/src/providers/__tests__/anthropic-brief-injection.test.ts` + `openrouter-brief-injection.test.ts` — assert the system prompt body contains the brief markers.
- `server/src/providers/__tests__/adapter-lockin.test.ts` — assert no fallback fires for `claude-sonnet` rate-limit when `providers.lock_to_chosen_model = true`.
- `.claude/knowledge/architecture.md` — append a `## Reasoner backends (model-aware)` entry under the existing Phase-16 architecture block. Distill from this plan.
- `.claude/knowledge/decisions.md` — append `## Reasoner backend follows the main model, not the user's preference flag` (the design rationale: cheap reasoning that matches the main provider beats a configurable mismatch).
- `.claude/knowledge/gotchas.md` — append `## Anthropic + OpenRouter providers used to skip the ctx-aware system prompt` (the bug this plan fixed, so future contributors don't re-introduce it).

## Migrations / data

N/A — no schema changes, no persistent state changes. The only "migration" is a new flag default; existing flag files don't need touching since defaults register at boot.

## Hooks / skills / settings to update

- `server/src/services/flags.ts` registrations: `providers.lock_to_chosen_model` (bool, default `true`); `reasoning.backend` (string, default `"auto"`, valid: `"auto" | "gemini" | "anthropic" | "openrouter"`).
- No `.claude/hooks/` or skill changes.

## Dependencies

- No new packages.
- New env contract: `ANTHROPIC_API_KEY` is now used both for main-model claude calls AND for the Anthropic reasoner backend. Document in `README.md`'s env-vars block.
- New env contract: `OPENROUTER_API_KEY` is used both for main-model OpenRouter calls AND for the OpenRouter reasoner backend (when chosen).

## Risks & mitigations

- **Risk:** Removing fallback chains traps users on a rate-limited paid provider with no auto-recovery. **Mitigation:** Keep the *retry* loop intra-provider (already present in `adapter.ts`). The flag `providers.lock_to_chosen_model` defaults to `true`; advanced users can flip it off if they want the old behaviour. Surface a clear error message when the limit hits with the `/model` slash-command hint to swap manually.
- **Risk:** Anthropic Haiku as reasoner doubles Anthropic spend for users on paid claude. **Mitigation:** Haiku at $0.80/M input is roughly the same as Gemini Flash; the existing reasoning cache (sha256 over context) shares hits across same-context calls, so per-turn additions stay bounded. Telemetry in `usage-log.ts` exposes `reasonerBackend` so the cost is observable.
- **Risk:** Stronger framing makes the model rigid even when the brief is wrong. **Mitigation:** Confidence-aware framing — only HIGH-confidence briefs get *"YOU MUST FOLLOW"* wording; MEDIUM stays directive but allows tool-result-driven deviation; LOW keeps today's advisory tone. Also: the new escape-hatch line *"surface the conflict in `reasoning` before deviating"* gives the model an explicit channel for disagreement rather than silent override.
- **Risk:** Wiring briefs into Anthropic could break the prompt cache. **Mitigation:** Anthropic's prompt cache works on prefix; `getSystemPrompt(ctx)` already separates the cacheable prefix from the dynamic tail (the brief is in the dynamic tail). Phase 16 Stage 3's elaboration brief already lives in the dynamic tail for Gemini without breaking caching there; Anthropic's cache will tolerate the same shape.
- **Risk:** Stage D adds three new code paths (one per backend) — easy to drift. **Mitigation:** Each backend exports the same `Backend` interface (`call(systemPrompt, userTurn, cfg) → Promise<string>`); the dispatcher in `task-reasoner.ts` is backend-agnostic. Add a contract test that every backend handles the same envelope shape.
- **Risk:** A user with NO API keys at all (no Gemini, no Anthropic, no OpenRouter) hits a NEW null-backend code path that didn't exist. **Mitigation:** `pickReasonerBackend` returns `null` in that case; `task-reasoner.runReasoning` already handles null returns by falling back to the legacy non-chunked flow (the same path the missing-`GEMINI_API_KEY` case has used since Phase 5). No new failure shape.

## Implementation order

1. **Stage A — Provider lock-in.** Smallest scope, highest user impact. Trim `MODEL_FALLBACK_CHAINS` for explicit picks; gate adapter fallback behind `providers.lock_to_chosen_model`. Run `npm test`. Land first so the user can verify the symptom they reported is gone.
2. **Stage B — Brief consumption in Anthropic + OpenRouter.** One-file changes per provider. Land before Stage C so the framing change has somewhere to land.
3. **Stage C — Brief framing strength.** Confidence-aware directive wording; one-file change in `reasoning-brief.ts`. Land before Stage D so the new framing rolls out via Gemini first (the existing path) before the new backends start using it.
4. **Stage D — Pluggable reasoner backend.** The architectural change. New `backends/` directory, new `pickReasonerBackend` helper, new dispatcher. Each backend lands as its own commit so reviewers can assess independently.
5. **Stage E — Tests, telemetry, knowledge entries.** Telemetry first (so we have observability when D lands in production); knowledge entries last (so they distill what actually shipped, not what we planned).

Each stage = one PR off `main`. Stage labels: `feat(providers): Stage A — lock chosen model`, etc. Bundling all five into one PR is rejected — too large to review safely.

## Verification

**Stage A**
- Test: `claude-sonnet` rate-limited → adapter emits `failed` with model-switch hint, no Gemini call observed via test spy.
- Test: `openrouter-auto` rate-limited → fallback chain still walks (cycling free models is the design intent for this ID).
- Manual: live-test claude-sonnet, force a 429 by exceeding tier-1 RPM, confirm the user-visible message says "Anthropic rate-limited" not "Invalid GEMINI_API_KEY".

**Stage B**
- Test: assert Anthropic request body's `system` field contains `═══ REASONING BRIEF` when `payload.reasoningBrief` is set.
- Test: assert OpenRouter messages[0] (`role: "system"`) content contains the same.
- Manual: run a multi-file scaffold with claude-sonnet; observe `<ReasoningPeek>` shows the brief AND claude's response references the architecture sketch.

**Stage C**
- Snapshot test: rendered section at HIGH/MEDIUM/LOW for each pipeline. Diff is reviewable.
- Manual: A/B compare two identical runs (one on `main`, one on this branch) on a borderline-confidence preflight; observe whether the new framing reduces the "model proceeds without using the brief" symptom.

**Stage D**
- Test: `pickReasonerBackend("claude-sonnet")` → `"anthropic"` when ANTHROPIC_API_KEY set; `"gemini"` when only GEMINI set; `null` when neither. Same table-test for each model.
- Test: each backend's `call()` returns a parseable envelope on a stub fetch; surfaces 429 as throw; surfaces 401 as null with logged error.
- Manual: with GEMINI_API_KEY *deliberately broken* (the user's current state), run claude-sonnet end-to-end; confirm `<ReasoningPeek>` populates, telemetry shows `reasonerBackend: "anthropic"`, and the chunked loop fires normally.

**Stage E**
- `npm test` — all suites pass (current 409/409 + however many new).
- `npm run typecheck` — clean.
- Manual: run telemetry summary; confirm `reasonerBackend` populates as expected across mixed-model runs.
- Knowledge entries lint via `memex-md add` to confirm the index gets a clean append.

## Out of scope

- **Auto-failover between reasoner backends.** If Anthropic Haiku rate-limits mid-run, we DON'T fall over to Gemini Flash automatically. The retry/timeout in `callReasonerWithTimeout` (PR #62) is enough for transient hiccups; persistent failures should surface so the user knows their backend is degraded. Cross-backend reasoner fallback is a future plan if telemetry shows this is a real pain.
- **Per-pipeline backend selection.** All pipelines for a given main-model use the same backend. We don't (yet) route preflight to Gemini and chunk_plan to Anthropic. If a future tuning shows benefit, the dispatcher already supports the additional axis.
- **Updating `MODEL_FALLBACK_CHAINS` for the swe model.** Out of scope; `swe` is a placeholder provider with non-production semantics.
- **Removing the legacy single-turn fallback** when `pickReasonerBackend` returns null. Today the handlers gracefully degrade without reasoning; that path stays untouched.
- **Migrating to Anthropic Haiku 4.5 (the current latest) for the reasoner explicitly.** The plan picks `claude-haiku-4-5` because it's currently the latest cost-effective reasoner; future Haiku versions can be swapped in `anthropic-backend.ts` without re-planning.

## Completion notes

All five stages shipped as separate PRs off `main`, merged in order:

- **PR #63** — Stage A: provider lock-in (`MODEL_FALLBACK_CHAINS` trimmed for explicit picks; `providers.lock_to_chosen_model` flag default-on)
- **PR #64** — Stage B: brief consumption in Anthropic + OpenRouter (`getSystemPromptForRequest` replaces static `SHARED_SYSTEM_PROMPT` in both providers)
- **PR #65** — Stage C: brief framing strength (confidence-aware HIGH / MEDIUM / LOW wording; "surface conflict in reasoning before deviating" escape hatch; iterative-refine pass via `runReasoningChain`; iterative paragraph chain mode)
- **PR #77** — Stage D: pluggable reasoner backend (`reasoning/backends/` directory + 3 backend modules + dispatcher; `pickReasonerBackend` in `free-tier-policy.ts`; `reasoning.backend` flag)
- **PR #78** — Stage E: telemetry + knowledge entries (`ClientResponse.reasonerBackend` field + per-run map in `task-reasoner.ts`; `RunSummary.reasonerBackend` → `usage.jsonl`; three knowledge entries: architecture for the model-aware reasoner shape, decisions for the same-vendor selection rationale, gotchas for the pre-Stage-B Anthropic/OpenRouter brief-injection bug)

**Deviations from the original plan:**

- Stage C grew a follow-up *"iterative paragraph chain"* mode (paragraph-by-paragraph reasoning across N Flash calls) that wasn't in the original plan. Surfaced as a separate kill switch (`reasoning.iterative_paragraph_chain_enabled`) so it can be toggled independently of the iterative-refine pass.
- Stage D's OpenRouter reasoner uses `google/gemini-2.0-flash-exp:free` (a free Google route on OpenRouter) rather than a paid OpenRouter reasoning model. The plan was non-specific; this choice keeps OpenRouter-routed runs free even when the reasoner path is exercised.
- Stage E's CLI capture is *first-observation-wins* rather than *latest-overwrite*. Since the backend is run-constant, the difference is moot in practice; *first-observation* is cheaper to reason about (set-once invariant).
- The plan listed `cli-client/src/agent/usage-log.ts` Stage E test additions inline with the field addition — they shipped as part of the same Stage E PR rather than separated.

**Telemetry / next-look items (NOT in this plan's scope but worth flagging):**

- Watch `usage.jsonl` for `reasonerBackend` distribution. If `anthropic` rate-limits start showing up as null-brief runs (= legacy fallback fired), revisit cross-backend reasoner fallback as a follow-up plan.
- The Stage B fix (briefs reach Anthropic + OpenRouter) is also what made Stage C's stronger framing actually useful for non-Gemini models. Future framing experiments should A/B against the new directive variants, not the pre-Stage-C advisory text.

**Knowledge entries captured:**

- `architecture.md: ## Reasoner backends (model-aware)` — the full backend shape + selection matrix + telemetry surface
- `decisions.md: ## Reasoner backend follows the main model, not the user's preference flag` — three rejected alternatives + the rule
- `gotchas.md: ## Anthropic + OpenRouter providers used to skip the ctx-aware system prompt` — the pre-Stage-B bug so future contributors don't re-introduce it
