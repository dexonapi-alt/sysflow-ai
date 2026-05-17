# Reasoning-chain provider parity (peek refresh on all backends)

- **Created:** 2026-05-16
- **Status:** in-progress
- **Scope:** Make the reasoning peek refresh on EVERY turn regardless of which model / provider is serving the run. Today the peek only refreshes when `response.reasoningChain[]` (array) is populated, which on `openrouter-auto` and other CJS-shaped models is almost never — those models emit `response.reasoning` (singular string) instead. The peek stays stuck on the initial brief (project_init or intent_classification) for the entire run.

## Goal

User report (2026-05-16):

> *"our reasoning is just stuck in the project initialization not using every iteration"*
>
> *"the reasoning is just the normal one for example like this `│ Verify that all newly created middleware, utils, and route files contain the intended code…` it's not on the chain reasoning it's in the inline reasoning which not using our reasoning."*

Investigation (Round 2 + Round 3) traced this to a provider-shape mismatch:

- The cli's `agent.ts` (Stage 3 of `applied/2026-05-15-agent-runtime-fixes-and-project-init-reasoning.md`) emits a `reasoning_brief` event ONLY when `response.perTurnReasoningChain` is a non-empty array.
- The mapper (`server/src/providers/normalize.ts`) populates `perTurnReasoningChain` from `normalized.reasoningChain` ONLY when the array exists and has length > 0.
- The Gemini path's normaliser extracts `reasoningChain` from the model's JSON response. The OpenRouter and Anthropic paths do not consistently extract it, OR the models served via those paths don't emit the field structurally (they put their deliberation in `response.reasoning` instead).
- Net: per-turn deliberation goes through the OLD `response.reasoning` (single string) path → renders inline as `│ <text>` via `revealReasoning()` → never reaches the peek.

The result is that the prior plan's Stage 3 fix was **provider-incomplete**: it works on Gemini but not on the default `openrouter-auto` users hit first.

End state — for ANY model on ANY provider:

- Every turn's deliberation reaches `<ReasoningPeek>` as a fresh `reasoning_brief` event with `kind: "per_turn"`.
- The inline `│` path STAYS for backwards compatibility but is no longer the only surface.
- When the model emits `response.reasoning` (singular) the normaliser synthesises a single-element `reasoningChain` for the cli, so the peek gets a refresh.
- When the model emits BOTH `reasoning` AND `reasoningChain[]`, the chain wins (richer).
- All three providers' system prompts include an instruction to populate `reasoningChain[]` so models that CAN produce structured output do.

## Context from knowledge base

- `architecture.md: ## Project-init reasoning` — Stage 1 of prior plan added the `project_init` brief path that the peek shows; this plan makes per-turn briefs use the same path.
- `decisions.md: ## Reasoning peek truncates by default; r toggles full view` — Stage 3's expand toggle stays unchanged; Stage 3 fixes only the data flow into the peek.
- `decisions.md: ## System-level enforcement beats prompt-level guidance for free models` — informs the normaliser fallback. We can't trust every model to emit `reasoningChain[]`; mechanical synthesis from `reasoning` is the safety net.
- `applied/2026-05-15-agent-runtime-fixes-and-project-init-reasoning.md` Stage 3 — the half-fix this plan completes.

## Affected files

### Stage 1 — Normaliser fallback: synthesise `reasoningChain` from `response.reasoning`

- `server/src/providers/normalize.ts` — `mapNormalizedResponseToClient`:
  ```ts
  case "needs_tool":
    return {
      ...,
      // BEFORE: only the array path
      perTurnReasoningChain: Array.isArray(normalized.reasoningChain) && normalized.reasoningChain.length > 0
        ? normalized.reasoningChain
        : undefined
      // AFTER: array path wins; fallback to singular when array is empty
      perTurnReasoningChain:
        Array.isArray(normalized.reasoningChain) && normalized.reasoningChain.length > 0
          ? normalized.reasoningChain
          : (typeof normalized.reasoning === "string" && normalized.reasoning.trim().length > 0
              ? [normalized.reasoning.trim()]
              : undefined)
    }
  ```
- Same fallback for the `completed` envelope.
- The synthesised single-element chain renders in the peek as one paragraph. The expand toggle (`r`) still works (no truncation needed for a single short paragraph; long ones still get capped at MAX_PARAGRAPH_CHARS until expanded).
- 6 new tests: array present → array used; array empty + reasoning present → synthesised single-element; both empty → undefined; whitespace-only reasoning → undefined; long reasoning → preserved verbatim.

### Stage 2 — All three provider system prompts include the reasoningChain emission directive

- `server/src/providers/prompt/sections/system-rules.ts` (or wherever the per-turn output schema is documented) — add an explicit `reasoningChain[]` rule:
  ```
  ═══ PER-TURN OUTPUT — REASONING CHAIN ═══

  On EVERY response, populate `reasoningChain` as an ARRAY of 1-4 short paragraphs
  (each 2-5 sentences) explaining what you just observed, what you're about to do
  next, and why.

  This is NOT optional. Single-string `reasoning` is legacy — `reasoningChain[]` is
  what the user sees in the live reasoning peek as you iterate. An empty array means
  the user sees no deliberation for this turn.

  Example:
  {
    "kind": "needs_tool",
    "tool": "write_file",
    "args": { "path": "src/foo.ts", "content": "..." },
    "reasoningChain": [
      "The previous tool listed the directory and confirmed src/ exists with index.ts.",
      "Writing src/foo.ts now because the build plan calls for the auth module before
       index.ts can import it. I'm putting the password hashing here to keep the
       dependency surface minimal."
    ]
  }
  ```
- This section is ALWAYS rendered (cacheable). Pure prompt change.
- Verify that all three provider paths (Gemini / Anthropic / OpenRouter via `base-provider.ts`) actually inject this section. Investigation Round 3 suggested Gemini's `buildPrompt` is the only async path; the others use synchronous `getSystemPromptForRequest` which may not include the same sections. Audit + close any gap.
- 4 new tests verifying the section appears in the rendered system prompt for each provider's path.

### Stage 3 — Provider-side response-parsing audit + per-provider Zod schema parity

- `server/src/providers/anthropic.ts` + `openrouter.ts` — find their response-parsing functions (where they extract the model's JSON envelope into `NormalizedResponse`). Verify `reasoningChain` is extracted from the JSON. If the field is missing in the parsed JSON BUT `reasoning` is present, the normaliser fallback (Stage 1) handles it — but provider-level extraction is more reliable.
- `server/src/reasoning/reasoning-schema.ts` (or wherever the response Zod schema lives) — ensure `reasoningChain: z.array(z.string()).optional()` is recognised on every provider's parse path.
- 6 new tests across the three providers: each one's response parser populates `reasoningChain` when the model emits it.

### Stage 4 — Telemetry + KB + plan archive

- `cli-client/src/agent/usage-log.ts` — `RunSummary` gains:
  - `reasoningChainEmittedTurns: number` (per-run count of turns where the model emitted `reasoningChain[]` as an array)
  - `reasoningChainSynthesisedTurns: number` (per-run count of turns where the cli only had singular `reasoning` to synthesise from)
  - Distribution across these two tells us whether the system-prompt directive (Stage 2) is working. Spike in synthesised + low array = directive being ignored → tighten or model-specific shim.
- KB:
  - `architecture.md` — extend the existing project-init diagram with a sub-section noting per-turn refresh works on both array + singular reasoning inputs.
  - `decisions.md: ## Normaliser synthesises reasoningChain from singular reasoning when needed` — rationale + the provider-parity gap that motivated it.
  - `gotchas.md: ## Reasoning peek stayed stuck on project_init across multi-turn run` — the canonical repro from the user.
- Plan archived to `applied/`.

## Migrations / data

None. Pure additive surface changes.

## Hooks / skills / settings to update

- No new flags. The existing `quality.project_init_reasoning_enabled` and the cli's expand toggle binding stay.

## Dependencies

- No new packages.

## Risks & mitigations

- **Synthesised single-element chains feel verbose in the peek.** Mitigation: the truncation cap (`MAX_PARAGRAPH_CHARS = 180`) already keeps single paragraphs short. The expand toggle handles long paragraphs.
- **Models that already populate `reasoning` AND emit `reasoningChain[]` — Stage 1 picks the chain.** No conflict.
- **System prompt bloat from Stage 2's new section.** Mitigation: section is cacheable; the per-turn output schema was already in the prompt — Stage 2 just makes the reasoningChain rule more explicit. Net token addition ~150-200 tokens.
- **Provider parity audit (Stage 3) reveals deeper inconsistencies than just reasoningChain.** Mitigation: document the gaps; fix only the chain-related ones in this plan. Other gaps surface in a future "provider parity" plan.
- **A user runs on a model that simply doesn't have the headroom for richer JSON output (smaller free-tier model).** Mitigation: the normaliser fallback (Stage 1) means even a model that only emits the singular `reasoning` string gets a refreshed peek. Stage 2's directive is best-effort, not a hard requirement.

## Implementation order

1. **Stage 1 — Normaliser fallback.** Smallest, highest-impact change. ~20 LOC. *(One PR.)*
2. **Stage 2 — Universal `reasoningChain[]` directive in system prompt.** Pure prompt change + audit that all providers use the same prompt builder. *(One PR.)*
3. **Stage 3 — Per-provider parser parity.** Reads through Anthropic + OpenRouter response handlers. *(One PR.)*
4. **Stage 4 — Telemetry + KB + plan archive.** *(One PR.)*

Each stage = one PR off `main`. ~500-700 LOC + 16-20 new tests across four stages. Smallest plan in this batch.

## Verification

**Stage 1**

- Unit: each branch of the synthesis fallback returns the expected shape. Round-trip a fixture response.
- Manual: run `sys` on openrouter-auto with a multi-turn implement task — observe peek refreshing on each turn (was stuck before).

**Stage 2**

- Unit: rendered system prompt contains the `reasoningChain[]` rule across all three provider paths.
- Manual: same test as Stage 1, but expect the model to emit `reasoningChain[]` (array) rather than relying on synthesis. Telemetry distribution shifts toward `reasoningChainEmittedTurns`.

**Stage 3**

- Unit: each provider's response parser populates `reasoningChain` when the model JSON includes it.

**Stage 4**

- Telemetry: `reasoningChainEmittedTurns` + `reasoningChainSynthesisedTurns` per-run. KB entries lint clean.

## Out of scope

- **Streaming partial reasoning paragraphs as they arrive.** Today the brief lands in one chunk per turn. Streaming would mean per-paragraph live updates. Deferred.
- **Provider-specific prompt-tuning for reasoningChain emission rates** (e.g. instructing GPT-OSS variants more aggressively because they're known to skip the field). Telemetry tells us if a future plan is needed.
- **Migrating the inline `│` render path away from `response.reasoning`.** Both paths can coexist; the inline render is cosmetic. Deferred.

## Composition with existing systems

- **Agent-runtime-fixes plan Stage 3** (applied 2026-05-15) — this plan completes that one's provider-parity gap. After this lands, the user-visible behaviour of "peek refreshes per turn" actually holds on all backends.
- **Code-correctness plan** (sibling, `2026-05-16-agent-code-correctness-and-completion-artifacts.md`) — when the tsc gate (Stage 3 there) blocks completion + injects diagnostics, the model's response to that inject will have `reasoningChain[]` that reaches the peek. Today it would stay stuck on project_init and the user wouldn't see what the model is thinking about the typecheck failure.
- **Accountability plan** (sibling) — when batches are capped at 3 tools requiring reasoning per file, the per-file reasoning needs to surface visibly. This plan's per-turn refresh makes that visible.
