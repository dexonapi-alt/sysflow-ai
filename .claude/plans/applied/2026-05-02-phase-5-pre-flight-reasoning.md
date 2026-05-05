# Sysflow Phase 5 — Reasoning System (Bug / Implement / Summary)

- **Created:** 2026-05-02
- **Status:** implemented (2026-05-02)
- **Scope:** Built-in reasoning system that fires across the agent's lifecycle on FOUR triggers — pre-flight (fresh prompt), self-invoked (agent calls a `reason` tool mid-execution when it hits a fork), on-error (after 2 consecutive failures), on-completion (before the final summary). Three pipelines (bug / implement / summary), shared meta-rules. Visible to the user, Zod-validated, cached, opt-out only via env.

## Goal

Stop the agent from guessing or hallucinating in four places it currently hurts: (1) when a fresh prompt is under-specified, (2) **mid-execution when it hits a non-trivial decision** (library choice, deletion safety, architectural fork, suspicious gotcha), (3) when something errors mid-run, (4) when wrapping up a complex task. Each gets a dedicated reasoning pipeline that decomposes the problem, ranks hypotheses, asks for missing context, and produces a structured brief the main agent and the user both see. Targeted result: when the user says "create an automation for spreadsheet" → reasoner picks Python+gspread, asks for Sheet ID + service-account JSON + share-with reminder. When the agent finishes writing a backend file and is about to choose ORM → it self-invokes the `reason` tool ("Drizzle vs Prisma for this codebase?") and gets a structured answer before continuing. When a tool fails three times → bug pipeline runs, ranks hypotheses, proposes the minimal safe fix. When the agent says "completed" → summary pipeline rewrites the message to lead with what changed, what to test, what's risky.

## Context from knowledge base

`.claude/knowledge/` is still empty. Relevant references on disk:

- `docs/sysflow-improvement/05-prompt-engineering.md` — modular sectioned prompt + dynamic boundary; reasoning briefs become a new non-cacheable section.
- `docs/sysflow-improvement/04-error-handling.md` — structured error categories; the `bug` pipeline consumes the existing `_errorCategory` from Phase 2's classifier.
- `docs/sysflow-improvement/01-foundations` notes — CONFIDENCE-AWARE (HIGH/MEDIUM/LOW) is already in the Sysflow system prompt; the reasoning system makes it operational instead of aspirational.
- `.claude/plans/applied/2026-05-02-phase-1-reasoning-and-cli-ux.md` — modular prompt registry + agent state machine.
- `.claude/plans/applied/2026-05-02-phase-2-foundation.md` — `services/project-memory.ts` mtime-cache pattern; `tool-error-classifier.ts` taxonomy reused by the bug pipeline.
- `.claude/plans/applied/2026-05-02-phase-3-capabilities.md` — Zod schemas + hook registry. Reasoning briefs are Zod-validated; reactive triggers (on-error, on-completion) plug into the existing hook registry.
- `.claude/plans/applied/2026-05-02-phase-4-productionisation.md` — feature flag system + vitest harness. Reasoning lands with tests + one env-only kill-switch flag.

## Affected files

### Server — `server/src/reasoning/` (new directory; refactor-friendly)

#### Shared infrastructure

- `server/src/reasoning/reasoning-schema.ts` *(new)* — Zod discriminated union over the three pipeline outputs. Common envelope: `{ pipeline: 'bug'|'implement'|'summary'|'simple', confidence: 'HIGH'|'MEDIUM'|'LOW', decision: 'proceed'|'ask_user', missingContext?: Array<{ field, whyCritical, suggestedQuestion, exampleValue }>, brief: BugBrief | ImplementBrief | SummaryBrief | null, reasoningTrace: string (max 800 chars) }`. `'simple'` short-circuits with no brief — used for trivial prompts ("list files in src", "what does this file do"). Each pipeline brief defined in its own `pipelines/*-schema.ts` file and re-exported here.
- `server/src/reasoning/meta-rules.ts` *(new)* — single source for the meta-rules block injected into every reasoning prompt: "no guessing when context is missing · prefer asking over hallucinating · decompose before solving · choose minimal safe changes · keep reasoning explicit internally but output clean · correctness > confidence tone". Exported as a constant.
- `server/src/reasoning/intent-classifier.ts` *(new)* — pure function that does a cheap regex/heuristic classification before the LLM call to short-circuit obvious cases: pure-read prompts ("show me…", "what is…") → `simple`, error-laden prompts ("fix this", stack-trace patterns, "TypeError:" / "ENOENT") → `bug`, pure summarisation requests ("explain", "summarise", "what does this do") → `summary`, otherwise → `implement` (and let the LLM confirm). Returns a hint, not a binding decision.
- `server/src/reasoning/task-reasoner.ts` *(new)* — `runReasoning({ trigger, payload })` orchestrator. `trigger` is `'preflight'|'on_error'|'on_completion'`. Builds the pipeline-specific prompt, calls the model with structured output (`responseSchema` for Gemini), validates with Zod, returns `ReasoningBrief | null`. On any failure returns `null`; the caller proceeds without a brief (graceful degradation).
- `server/src/reasoning/reasoning-cache.ts` *(new)* — sha256-keyed in-memory cache. Key includes `trigger + userMessage + cwd + model + projectMemoryMtime + (errorContext ?? '')`. TTL 30 min. FIFO eviction at 200 entries. `get`/`set`/`reset` exported.
- `server/src/reasoning/critical-context-detector.ts` *(new)* — pure cross-check that runs after the reasoner: prunes `missingContext` entries whose `field` substring already appears in `userMessage`; promotes `decision` to `ask_user` if any HIGH-criticality item remains; demotes to `proceed` if user said "just guess" / "use whatever" / "best effort".
- `server/src/reasoning/examples.ts` *(new)* — curated few-shot examples grouped by pipeline. Implement examples (12+): spreadsheet → Python+gspread+google-auth (asks Sheet ID + service-account JSON + share reminder); web scraper → Python+playwright (asks URLs + auth); REST API in existing repo → re-use existing stack; CLI with binary distribution → Go/Rust; React landing page → React+Vite+Tailwind+Framer; Discord bot → Node+discord.js (asks bot token + guild ID); Stripe integration → asks product/price IDs; cron script → asks schedule + host; etc. Bug examples (8+): null-pointer-after-deploy → check env config; flaky test → race condition hypothesis; "fix the build" → check tsc/eslint output, propose minimal change; ENOENT after rename → search-then-update import paths; etc. Summary examples (4+): "explain this codebase" → architecture-level cluster; "what changed" → diff-driven cluster; etc. Each example: `{ prompt, errorCtx?, expectedOutput, note }`.

#### Pipeline modules

- `server/src/reasoning/pipelines/bug-pipeline.ts` *(new)* — system prompt + Zod schema for the bug pipeline. Brief shape: `{ symptom, expectedVsActual: { expected, actual }, suspectedBoundary: 'frontend'|'backend'|'db'|'infra'|'race_condition'|'config'|'deps'|'unknown', hypotheses: Array<{ hypothesis, supportingEvidence, probability: 'HIGH'|'MEDIUM'|'LOW', invalidatingTest }>, rootCauseGuess: string | null, proposedFix: { description, scope: 'minimal'|'moderate'|'large', filesAffected: string[] }, sideEffects: string[], verificationSteps: string[] }`. Hypotheses array max 5, sorted by probability.
- `server/src/reasoning/pipelines/implement-pipeline.ts` *(new)* — system prompt + Zod schema for implementation. Brief shape: `{ intent, subcomponents: Array<{ name, kind: 'ui'|'api'|'db'|'logic'|'config'|'infra' }>, recommendedStack: { language, frameworks, libraries, runtime, rationale }, architectureSketch: string (max 400 chars), buildPlan: Array<{ step, deliverable, blockedBy: string[] }>, edgeCases: string[], consistencyNotes: string[] }`. Build plan max 8 steps.
- `server/src/reasoning/pipelines/summary-pipeline.ts` *(new)* — system prompt + Zod schema for summarisation. Brief shape: `{ audienceLevel: 'beginner'|'dev'|'mixed', keyFacts: string[], clusters: Array<{ heading, points: string[] }>, constraints: string[], whatMatters: string[], whatDoesnt: string[], hallucinationCheck: { suspect: string[], verified: string[] } }`. Clusters max 5, key facts max 8.
- `server/src/reasoning/pipelines/index.ts` *(new)* — dispatch helper: `getPipelineConfig(kind)` returns `{ systemPrompt, schema, examples }` for the right pipeline. Used by `task-reasoner.ts`.

#### Trigger integration

- `server/src/handlers/user-message.ts` — **pre-flight trigger**: after `loadProjectContext`, before `callModelAdapter`, run `runReasoning({ trigger: 'preflight', payload })`. Three branches: `null` → existing behaviour; `decision: 'proceed'` → brief stuffed into `context.reasoningBrief`; `decision: 'ask_user'` → return `waiting_for_user` with the consolidated questions + the chosen stack/rationale so the user knows why.
- `server/src/handlers/tool-result.ts` — **on-error trigger**: when an incoming tool result has `_errorCategory` AND the run has hit ≥ 2 consecutive errors, run `runReasoning({ trigger: 'on_error', payload: { ...lastError, recentActions } })` and inject the resulting bug brief into `context.reasoningBrief` for the next provider call. Cap: at most 2 on-error reasoning calls per run (cost guard).
- `server/src/handlers/tool-result.ts` — **on-completion trigger**: when `normalized.kind === 'completed'` AND the run was non-trivial (stepCount ≥ 5 OR filesWritten ≥ 3), run `runReasoning({ trigger: 'on_completion', payload: { originalTask, filesWritten, runActions, draftMessage: normalized.content } })` and replace `normalized.content` with the summary brief's rendered message (clusters + whatMatters + verification). Falls through to original message on `null`.
- **Self-invoked trigger** — synthetic `reason` tool that the agent calls itself. See the next section.
- `server/src/providers/prompt/sections/reasoning-brief.ts` *(new)* — non-cacheable section. Renders the right brief shape based on `pipeline`. For bug: shows hypotheses + proposed fix + side effects. For implement: shows stack + buildPlan + edgeCases. For summary: shows the rendered summary directly. Always includes the meta-rules reminder + an "ASSUMED:" / "FROM USER:" block so the agent doesn't re-ask for things already known.
- `server/src/providers/prompt/build.ts` — register the new section at priority 107. `PromptCtx` extends `ReasoningBriefCtx`.
- `server/src/types.ts` — export `ReasoningBrief`, `BugBrief`, `ImplementBrief`, `SummaryBrief`, `ReasoningTrigger` (now 4 values: `'preflight'|'self_invoked'|'on_error'|'on_completion'`). Add `ClientResponse.reasoningBrief?: ReasoningBrief` so the CLI sees it.

#### Self-invoked reasoning — the `reason` tool

This is the layer that lets the agent decide for itself when to reason — between writing files, before deleting something, when picking between two libraries, when something looks suspicious. The agent decides; the human only sees the result.

- `cli-client/src/agent/tool-schemas.ts` — register `reason` tool. Args: `{ question: string (max 500), context?: string (max 1500), options?: string[] (max 6, each max 100 chars), kind?: 'bug'|'implement'|'choice'|'gotcha' }`. Validation via Zod like every other tool.
- `cli-client/src/agent/tool-meta.ts` — `reason` is `isConcurrencySafe: true`, `isReadOnly: true`, `defaultPermission: 'allow'` (no permission prompts; it's pure thinking).
- `cli-client/src/agent/executor.ts` — dispatch `reason` to a new local handler that posts to a server endpoint `POST /reason` (or hijacks the existing `/agent/run` payload type). The CLI side stays thin — it just forwards args + waits for the structured brief.
- `server/src/routes/reason.ts` *(new)* — Fastify route receiving `{ runId, question, context, options, kind }`. Calls `runReasoning({ trigger: 'self_invoked', payload: { ...args } })`. Returns the brief or a fallback `{ answer: "(reasoning unavailable, proceed with best judgement)" }` on null.
- `server/src/reasoning/task-reasoner.ts` — when `trigger === 'self_invoked'`, route to a slimmer "decision" pipeline (a fourth pipeline file `pipelines/decision-pipeline.ts`) optimised for short, ranked answers. Brief shape: `{ recommendation, alternatives: Array<{ option, prosCons, fitScore }>, confidence, riskNotes, proceedHint }`. Faster than a full implement/bug brief because it's a *single decision*, not a whole plan.
- `server/src/reasoning/pipelines/decision-pipeline.ts` *(new)* — short prompt, narrow schema. Reuses meta-rules. Few-shot examples in `examples.ts`: ORM choice (Drizzle vs Prisma), state lib (Zustand vs Redux), dirty-file deletion safety, monorepo vs single repo for a small project, etc.
- `server/src/providers/prompt/sections/tools.ts` — add `reason` to the tools section with explicit guidance: "Use `reason` BEFORE making non-trivial decisions you're not HIGH-confident about. Examples: choosing a library when the project doesn't pin one yet, deciding whether to delete a file you didn't create, picking an architectural pattern. Cost is one short reasoning call; benefit is not making a wrong call you'll have to undo. Don't overuse — for HIGH-confidence routine moves, just act."
- `server/src/providers/prompt/sections/task-guidelines.ts` — add to the CONFIDENCE-AWARE rule: "Concretely: HIGH → act. MEDIUM → call `reason` if reversal would be expensive (file deletion, architectural commit, dependency choice); otherwise note the assumption and act. LOW → call `reason` always, or ask the user if `reason` itself returns LOW confidence."
- **Cap on self-invoked calls per run**: configurable via `reasoning.max_self_invocations_per_run` flag (default 5). Above the cap, the tool returns a "you've hit the reasoning budget — proceed with best judgement and explain in your final summary" string so the agent doesn't loop forever calling itself.
- `cli-client/src/cli/reasoning-display.ts` — add `renderDecisionBrief(brief)`. Renders inline with the tool's preview line: `┌── reason: Drizzle vs Prisma → Drizzle (HIGH) ──┐\n│ Why: matches existing pg setup, smaller deps...`. Brief is collapsed by default; Tab expands like the existing diff preview.
- The agent's *answer* to its own question is logged in the audit + usage trail with `tool: 'reason'` so a human can later see why it picked what it did.

#### Telemetry + flags

- `server/src/services/flags.ts` — add `prompt.preflight_reasoning_enabled` (default `true`), `prompt.self_invoked_reasoning_enabled` (default `true`), `prompt.on_error_reasoning_enabled` (default `true`), `prompt.on_completion_reasoning_enabled` (default `true`), `reasoning.max_output_tokens` (default `2_500`), `reasoning.max_self_invocations_per_run` (default `5`), `reasoning.cache_ttl_minutes` (default `30`).
- `server/src/handlers/user-message.ts` + `tool-result.ts` — emit a `reasoning_used` line in the existing audit/usage path: `{ trigger, pipeline, decision, confidence, durationMs, cacheHit }`. Wired through to the CLI's `usage.jsonl`.

### CLI — render the brief, surface the ask

- `cli-client/src/cli/reasoning-display.ts` *(new)* — three render functions, one per brief shape. `renderImplementBrief` shows the stack box ("Task: spreadsheet automation · Stack: Python+gspread · Asking: Sheet ID, service-account JSON"). `renderBugBrief` shows the hypothesis list with probability tags. `renderSummaryBrief` is a passthrough — the brief IS the user-facing message. All use the existing `colors`/`BOX` from `cli/render.ts`.
- `cli-client/src/agent/agent.ts` — when the initial response (or any subsequent response) carries `reasoningBrief`, render it via the right function before the spinner restarts. Pre-flight briefs render once before step 1; on-error briefs render between the failure line and the next retry; summary briefs replace the summary box content.
- `cli-client/src/agent/state-machine.ts` — extend `Transition` with `reasoning_ask` (currently `user_responded` is reused; this gives the controller a way to render the question with extra "asked because the agent needs X" framing).
- `cli-client/src/agent/usage-log.ts` — add `reasoningCalls: number` and `reasoningTriggers: ReasoningTrigger[]` to `RunSummary`.

### Tests

- `server/src/reasoning/__tests__/reasoning-schema.test.ts` *(new)* — discriminated union: each pipeline shape parses; cross-pipeline shapes rejected; oversized `reasoningTrace` rejected; `decision` and `confidence` enums constrained.
- `server/src/reasoning/__tests__/critical-context-detector.test.ts` *(new)* — HIGH-criticality + not in prompt → `ask_user`; "just guess" demotes to `proceed`; LOW criticality stays as `proceed`; field-substring pruning ("sheet id" in user message strips that question).
- `server/src/reasoning/__tests__/intent-classifier.test.ts` *(new)* — heuristics: stack traces → `bug`; "explain" / "summarise" / "what does X do" → `summary`; "list files" / "show me" → `simple`; everything else → `implement`. ~10 cases.
- `server/src/reasoning/__tests__/reasoning-cache.test.ts` *(new)* — get/set, TTL expiry (mockable clock), FIFO eviction, key includes trigger + cwd + model so collisions are isolated.
- *(deferred)* end-to-end pipeline tests need a model mock — wire after the schema/cache/detector pieces stabilise.

### Docs

- `docs/status/current.md` — Recent Work entry for Phase 5.
- `docs/sysflow-improvement/14-complete-gap-checklist.md` — check off CONFIDENCE-AWARE, hypothesis ranking, ask-before-invent, structured tool-result summarisation, and the new "Pre/on-error/on-completion reasoning hooks" addition under the Phase 1–4 list.

## Migrations / data

N/A. Reasoning cache is in-memory. Wire-protocol gains one optional additive field (`reasoningBrief`) on every server response — clients that don't know about it ignore it.

## Hooks / skills / settings to update

N/A.

## Dependencies

- No new npm packages. Zod and the Gemini SDK are already deps. SHA-256 via Node's built-in `crypto`.
- No new env vars beyond the four feature flags noted above (no UI for them; they're env-only kill switches).

## Risks & mitigations

- **Self-invoked reasoning explosion** — agent calls `reason` on every micro-decision and the run takes 5× longer. → Hard cap at 5 self-invocations per run via `reasoning.max_self_invocations_per_run`. Above the cap, the tool returns "budget exhausted, proceed with judgement". System-prompt guidance is explicit about when NOT to call `reason` (HIGH-confidence routine moves). Each call is logged in the audit so we can tune the cap based on real usage.
- **Self-invoked reasoning loops** — agent reasons, then reasons about its reasoning, then reasons about that. → Recursion guard in `task-reasoner.ts`: if `trigger === 'self_invoked'` and the call stack already contains a self-invoked reasoning call for the same `runId`, reject immediately. The reasoning model itself never calls tools — it's a one-shot structured-output call.
- **Latency** — each trigger adds one round-trip. Pre-flight is ~1–2s on Gemini Flash; on-error and on-completion only fire on non-trivial paths; self-invoked fires only when the agent decides it's worth it. → Cache hits are free; intent classifier short-circuits trivial prompts to `simple` (no reasoning call). Each trigger is independently disablable via env.
- **Token cost** — 1–3 extra calls per non-trivial run. → Reasoner output capped at 2_500 tokens; cache hit on identical prompt; on-error capped at 2 calls per run.
- **Reasoner picks the wrong stack / wrong root cause** — visible in the CLI brief. The user redirects on the next prompt ("no, use Node not Python") and the next reasoning call sees the redirected message. Plus the reasoner sees `directoryTree` + `projectMemory` so existing-project signals override the few-shot defaults.
- **Reasoner asks for context the user already gave** — caught by `critical-context-detector.ts` field-substring prune; reasoner's prompt also explicitly says "Re-read the user's message before listing missingContext."
- **Reasoner hallucinates a brief that contradicts itself** — Zod schema rejects malformed shapes; `null` returned; main flow runs as before.
- **On-completion brief overwrites a perfectly fine completion message** — only triggered for non-trivial runs (stepCount ≥ 5 OR filesWritten ≥ 3). Trivial runs keep the model's original message.
- **Bug pipeline misclassifies a real fix as a hypothesis** — caller still has the actual error; bug brief is advisory, not binding. Agent can choose to override.
- **Cache pollution across cwds / models** — key includes both, plus projectMemory mtime so a `.sysflow.md` edit invalidates.
- **Discriminated union schema is unwieldy in Gemini's responseSchema** — Gemini's structured-output supports nullable fields and unions but not always cleanly. → Schema returns the envelope with all four `*Brief` fields nullable; the reasoner fills exactly one based on `pipeline`. Validate via Zod after parse, not via Gemini's enforcement, so we can fall back to `null` if needed.

## Implementation order

Each step compiles green and is independently revertable. Steps 1–3 build the shared foundation; 4–7 build the four pipelines; 8–11 wire triggers; 12–13 ship CLI + tests; 14 ships docs.

1. **Shared schema + types** — `reasoning-schema.ts`, `meta-rules.ts`. Add discriminated union + brief shapes (including `DecisionBrief`) to `types.ts`. Pure addition.
2. **Intent classifier** — `intent-classifier.ts` with heuristics for the four buckets. Pure regex; tested.
3. **Cache + critical-context detector** — `reasoning-cache.ts` (sha256, FIFO 200, TTL 30 min) and `critical-context-detector.ts` (cross-check + prune). Pure helpers.
4. **Implement pipeline** — `pipelines/implement-pipeline.ts` with prompt + schema. Few-shot examples in `examples.ts`.
5. **Bug pipeline** — `pipelines/bug-pipeline.ts`. Reuses Phase 2's `tool-error-classifier.ts` to seed `suspectedBoundary` heuristically.
6. **Summary pipeline** — `pipelines/summary-pipeline.ts`. Audience inference based on whether the run touched UI vs infra files.
7. **Decision pipeline** — `pipelines/decision-pipeline.ts` with prompt + narrow schema for the self-invoked path. Few-shot examples covering ORM choice, state-management lib, dirty-file deletion safety, monorepo decision.
8. **Reasoner orchestrator** — `task-reasoner.ts` with the `trigger`-aware dispatch into the right pipeline. Calls Gemini directly, validates with Zod, returns `ReasoningBrief | null`. Includes the recursion guard for self-invoked.
9. **Pre-flight trigger** — wire into `handlers/user-message.ts` (after context load, before model call). Implement the three decision branches. Add the new prompt section + register in `prompt/build.ts`.
10. **On-error + on-completion triggers** — wire into `handlers/tool-result.ts`. Caps: max 2 on-error reasoning calls per run, completion reasoning gated on non-trivial runs. Plumb the resulting brief into `ClientResponse.reasoningBrief` for CLI rendering.
11. **`reason` tool + self-invoked trigger** — register in `tool-schemas.ts` + `tool-meta.ts`; new `routes/reason.ts` Fastify route; CLI executor handler that forwards to the route; per-run invocation counter with the cap. Add the tool to `prompt/sections/tools.ts` with usage guidance.
12. **CLI rendering** — `cli/reasoning-display.ts` with four render functions; agent.ts renders the brief on receipt; state machine adds `reasoning_ask` reason; usage-log captures `reasoningCalls`, `reasoningTriggers`, `selfInvocationCount`.
13. **Tests** — schema, cache, detector, intent classifier, self-invocation cap, recursion guard (~30 cases). Pipeline-specific tests deferred to after first manual smoke shows the prompts produce stable output.
14. **Docs + checklist update.**

## Verification

- **Compile:** `tsc --noEmit` clean in both packages.
- **Tests:** `npm test` in `server/` adds ~25 new cases passing.
- **Manual smoke (the canonical flows):**
  - **Pre-flight, ambiguous implement**: `"create an automation for my spreadsheet that sums column B by category"` → reasoner returns `pipeline: implement`, `decision: ask_user`, `missingContext: [Sheet ID, service-account JSON]`. CLI renders the implement brief box, then asks the consolidated question. After the user pastes the JSON path + Sheet ID, the next turn carries the brief into the main loop and the agent generates the Python script + reminder to share the sheet with the service-account email.
  - **Pre-flight, existing-project clear-implement**: `"add a button to the navbar"` (in a React project) → reasoner sees `directoryTree` + `package.json` + `Navbar.tsx`, returns `pipeline: implement`, `decision: proceed`, `missingContext: []`. No question, agent proceeds; brief in the prompt nudges it to follow the existing pattern.
  - **Pre-flight, simple**: `"list the files in src"` → intent classifier returns `simple`, no reasoning call, agent runs immediately.
  - **Self-invoked, library choice**: agent is implementing a backend, has finished the route handlers, needs an ORM. The project's `package.json` doesn't pin one. Agent calls `reason({ kind: 'choice', question: 'Which ORM should I use for this Postgres setup?', context: '<tail of pkg.json>', options: ['Drizzle', 'Prisma', 'TypeORM'] })`. Decision brief comes back with `recommendation: Drizzle, confidence: HIGH, why: ...`. CLI renders the inline collapsed brief; agent installs Drizzle and continues.
  - **Self-invoked, deletion safety**: agent finds an orphan file `legacy/old-auth.ts` while refactoring. Before deleting, calls `reason({ kind: 'gotcha', question: 'Is it safe to delete legacy/old-auth.ts? It has no inbound imports per my search.', options: ['delete', 'keep', 'rename to .bak'] })`. Decision brief: `recommendation: keep, confidence: MEDIUM, riskNotes: 'no test coverage on the import graph'`. Agent keeps the file and notes it in the final summary.
  - **On-error trigger**: a deliberate `read_file` of a missing path → first error retries normally; second error of the same kind triggers the bug pipeline; CLI renders the hypothesis list ("file moved · path typo · case mismatch"); agent's next action follows the proposed fix (search_files for the basename).
  - **On-completion trigger**: a multi-file build (8+ files) → summary pipeline runs after the agent says `completed`; the box shows clusters + what-matters + verification steps instead of the raw model message.
  - **Self-invocation cap**: a stress-test prompt that would tempt many decisions → confirm the agent stops at 5 reasoning calls and continues with judgement on calls 6+, with a single audit-log line explaining the budget exhaustion.
- **Cache check:** same prompt twice in a row hits the cache (`[reasoning] cache hit trigger=preflight`) and skips the model call.
- **Latency budget:** pre-flight reasoning < 2s on Gemini Flash; on-error < 2s; on-completion < 3s. Track in `usage.jsonl` via the new `reasoningCalls` field.

## Follow-ups (out of scope this session)

- **File restructure** — next plan; the new `server/src/reasoning/` directory is the seed.
- **Reasoning preferences in `.sysflow.md`** — let users add stack overrides ("we use Bun, not Node") that the reasoner respects.
- **Dedicated reasoner model** — let the reasoner always use Gemini Flash even when the main loop uses Claude Sonnet. Cheaper + faster.
- **Reasoning trace mining** — periodically aggregate `usage.jsonl`'s reasoning rows to surface "this user mostly builds X" patterns.
- **Reasoning-aware retry** — if the agent fails 3× on the same task, re-run pre-flight reasoning with the failure history as additional context.
- **Pipeline-specific tests** — once the prompts stabilise, add e2e tests with a recorded model response fixture.

## Completion notes

Implemented 2026-05-02. All 14 ordered steps executed in sequence and pushed as separate feature/test/docs commits.

**Deviations from the plan:**

- The "dedicated reasoner model" follow-up was implemented opportunistically during step 8 — `task-reasoner.ts` always calls `gemini-2.5-flash` regardless of the main agent's model. The original plan deferred this; rolled it in because it simplifies the code (one model dependency) and aligns with the latency goal.
- Pipeline-specific tests deferred entirely. Schema + cache + intent + detector tests give us coverage on the pure paths; the LLM-call side will need a recorded-fixture harness in a follow-up.
- The on-completion brief renders the summary content directly into `normalized.content` (replacing the agent's draft). A more conservative variant would surface BOTH (agent's draft + refined summary) so reviewers can diff them. Punted; can be a flag if it matters.
- `taskReasoner` recursion guard uses an in-flight set keyed on `cwd::userMessage` — sufficient because the reasoning model never has tool access (so it can't actually re-enter), but defensive in case future code paths route through `runReasoning` indirectly.
- Discriminated-union envelope in Zod kept the four `*Brief` slots as nullable optionals + a post-parse `assertEnvelopeShape` invariant. Tried Zod's `discriminatedUnion` but the `pipeline` field is on the envelope, not the brief, so a manual check is cleaner.

**Surprises:**

- The intent classifier carried more weight than expected — short-circuiting trivial prompts to `simple` (no model call) is what keeps the latency budget honest. Without it, every "list files in src" would burn a round-trip.
- `examples.ts` is by far the biggest single file at ~830 lines — entirely few-shot example data. It's a good candidate to split per-pipeline if it grows further (deferred until it actually does).
- The `reason` tool integration through the existing executor was clean: a 30-line short-circuit before the regular dispatch + a small fetch helper. The hardest part was keeping the import-cycle-free contract on `ReasoningBrief` (used `unknown` in `types.ts` and only the rendering code knows the actual shape).

**Knowledge to capture (next pass):**

- "Four-trigger reasoning architecture (preflight / self_invoked / on_error / on_completion)" pattern → `.claude/knowledge/architecture.md`.
- "Discriminated envelope with post-parse invariant" Zod pattern → `.claude/knowledge/patterns.md`.
- "Always run reasoning on Gemini Flash regardless of main model" → `.claude/knowledge/decisions.md`.
- "Recursion guard via in-flight Set keyed by cwd+userMessage" → `.claude/knowledge/patterns.md`.
