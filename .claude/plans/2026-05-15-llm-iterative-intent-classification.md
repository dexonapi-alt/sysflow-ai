# LLM-driven iterative intent classification (replace the brittle regex)

- **Created:** 2026-05-15
- **Status:** draft
- **Scope:** Replace `intent-classifier.ts`'s regex-based hint with an LLM-driven **iterative paragraph chain** that uses the same self-directing-depth pattern already shipped for preflight reasoning (`runIterativeChain` in `task-reasoner.ts`). Each iteration is a short Flash call producing ONE senior-engineer-flavoured paragraph (whys, trade-offs, end-to-end check, double-check) + a `done` flag the LLM ITSELF raises when it's ready to commit. The depth is **adaptive**: trivial prompts commit after 1 iteration, ambiguous ones keep reasoning (up to MAX_ITERATIVE_STEPS = 6). The regex stays as the fast-path for obvious cases + the fallback when no reasoner backend is available.

## Goal

The current `classifyIntent` is a cheap regex that hits a sharp false-positive every time a build prompt mentions an error-class noun inside its feature list. The 2026-05-15 user report — *"build a Node.js Express PostgreSQL backend ... validation middleware, error handling, pagination ..."* — was mis-routed to the bug pipeline because `\berror\b` matched the word *"error"* inside *"error handling"*. PR #82 patched the specific case with an implement-anchor regex, but the underlying problem stays: **compound nouns containing error/exception/fail/crash-class words are landmines, and the regex has no way to understand intent**.

The user's framing:

> *"why don't we just use the llm with the deep reasoning to decide if its a implement, bug, and more feature. like it should be normal and plain but the best thing is the deep multi reasoning to llm it should be like reason → llm → reason in plain → llm → reason in plain → decide. this ensure the llm accuracy produces high quality output even in free models right?"*

After this plan: intent classification uses the **same iterative paragraph chain** pattern already proven for preflight reasoning. **The LLM itself decides how deep to go**, not a hand-coded gate. Each iteration produces ONE plain-prose paragraph thinking like a senior engineer — asking itself questions, weighing trade-offs, considering the prompt end-to-end, double-checking the prior paragraph's reasoning before either committing (`done: true`) or asking for another iteration. Trivial prompts settle in 1 iteration; genuinely ambiguous ones may take 3-4. The 6-step cap from `runIterativeChain` is the safety net, not a schedule.

### The loop (self-directing depth, max 6 iterations)

```
prompt
  │
  ▼
[regex fast-path]  ─── HIGH-confidence match (bare `ls`, `/continue`, stack-trace shape)
  │                      → skip the LLM chain, commit immediately
  │
  ▼
LLM iter 1 ─── ┐  Senior-engineer paragraph: restate prompt in own words,
               │  identify ambiguity, form initial hypothesis, ASK why this
               │  hypothesis vs alternatives, name trade-offs, decide if
               │  more reasoning needed.
               │  Output: { paragraph, hypothesis?, confidence, done }
               ▼
       done: true ── ✓ commit + cache
               │
       done: false → LLM iter 2 ─── (sees iter-1 paragraph; addresses the
                                     open questions iter-1 raised; can
                                     SUPERSEDE iter-1's paragraph if it
                                     changes its mind)
                       │
               ▼
        done: true ── ✓ commit
               │
               ▼  (... repeat until done or MAX_ITERATIVE_STEPS = 6)
               │
               ▼
        Final iteration must commit (no recursion past 6).
        If the chain runs to the cap without committing, the
        last-emitted hypothesis is taken with confidence: LOW
        and the regex fallback double-checks.
```

### Senior-engineer paragraph rubric (in the system prompt)

Each iteration's paragraph MUST cover, in plain prose (not a form):

1. **Restate** — what is the user actually asking? Their exact words matter.
2. **Why this hypothesis vs others** — name the alternative classifications and why this one wins.
3. **Trade-offs** — what would I be missing if I'm wrong? What's the cost of mis-classifying as bug vs implement?
4. **End-to-end check** — if I commit to X, what pipeline runs? Would the agent ask the right questions / take the right actions?
5. **Double-check** — re-read the prompt's exact opening verb + any compound nouns (error handling, exception middleware, fail-safe). Don't trip on feature-list nouns.
6. **Decide** — commit with `done: true` + `hypothesis`, OR raise the specific question I need another pass to resolve (`done: false`, `paragraph` ends with the question).

The first iteration's paragraph is usually enough for obvious prompts. The LLM only requests more iterations when the trade-offs aren't clean — that's the depth control the user asked for: *"every word is accounted... the first llm call and reasoning can determine whether it needs more reasoning"*.

### Composition

This composes with Phase 19 (CLI render gate reads `runIntent`) and Phase 18 Stage 5 (server emission gate). Both consume the `IntentHint` value — the SOURCE of that value changes from regex to iterative-LLM, the rest stays. PR #82's implement-anchor regex stays in the regex classifier as the fast-path / fallback.

## Context from knowledge base

- `decisions.md: ## Chain WITHIN a concern, peer ACROSS concerns` — informs the design. Intent classification is ONE concern (deciding pipeline route); chaining N Flash calls within it is correct. Cross-concern would be "intent + complexity + memory recall all in one Flash" — explicitly rejected pattern.
- `decisions.md: ## Conservative heuristics — only flag unambiguous mismatches` — the regex IS a conservative heuristic. The LLM stages are conservative too (commit only when confidence is HIGH; otherwise pass to next stage). Falling back to regex on chain failure preserves the conservatism.
- `decisions.md: ## Task box gates on intent classification, not on prior-render heuristics` — the same Phase 19 entry. After this plan, the gate still reads `runIntent`; the value is just more accurate.
- `decisions.md: ## TaskPlan emission gates on intent + complexity` — Phase 18 Stage 5's defensive drop reads the same `runIntent`. After this plan, fewer false positives mean fewer stray drops.
- `gotchas.md: ## "error handling" in a feature list mis-classified build prompts as bug reports` — the failure mode this plan eliminates structurally rather than band-aiding regex by regex.
- `architecture.md: ## Reasoner backends (model-aware)` — Phase D shipped a backend dispatcher. The intent-classification chain uses the same dispatcher, so a sysflow run with only `ANTHROPIC_API_KEY` set still classifies via Haiku.
- `applied/2026-05-07-phase-16-deep-reasoning-on-free-models.md` — Phase 16 built `runReasoningChain`. This plan is its third concrete use case (after `implement_elaborate` and chained divergence second-look).

## Affected files

### New reasoning pipeline + schema

- `server/src/reasoning/pipelines/intent-classification-pipeline.ts` (NEW) — system prompt for the Flash classifier. Frames the task as iterative paragraph reasoning (NOT a form to fill). The prompt includes the **six-point senior-engineer rubric** (restate / why this hypothesis / trade-offs / end-to-end / double-check / decide). Emphasises the bug-verb vs feature-list-noun distinction with examples (*"build a service with error handling"* → implement; *"the auth service throws an error on login"* → bug). The pipeline output is a JSON envelope per iteration so the orchestrator can parse `done` + `paragraph` + `hypothesis` + `confidence`.
- `server/src/reasoning/reasoning-schema.ts` — add `intentClassificationStepSchema` (per-iteration output) and `intentClassificationBriefSchema` (final, after the chain settles). The step schema mirrors `IterativeStepResponse` so the chain orchestrator can reuse the same parsing pattern:
  ```ts
  // Per-iteration: what the LLM emits each step.
  const intentClassificationStepSchema = z.object({
    paragraph: z.string().min(1).max(1200),    // senior-engineer prose
    done: z.boolean(),                          // LLM decides commit or iterate
    hypothesis: z.enum(["simple", "bug", "summary", "implement"]).nullable(),
    confidence: z.enum(["HIGH", "MEDIUM", "LOW"]).nullable(),
    supersedes: z.number().int().min(0).nullable().optional(), // can revise a prior paragraph
  })

  // Final brief: what the orchestrator returns after the chain settles.
  intentClassificationBriefSchema = z.object({
    kind: z.literal("intent_classification"),
    confidence: z.enum(["HIGH", "MEDIUM", "LOW"]),
    intentClassificationBrief: z.object({
      hypothesis: z.enum(["simple", "bug", "summary", "implement"]),
      // Full reasoning chain — surfaces in <ReasoningPeek> + telemetry.
      paragraphs: z.array(z.string().min(1)).min(1).max(6),
      // How many iterations actually fired (cap = 6).
      iterations: z.number().int().min(1).max(6),
      // Whether the LLM committed via `done: true` or the cap forced commit.
      committedVia: z.enum(["done_flag", "step_cap", "regex_fallback"]),
    }),
  })
  ```
- `server/src/reasoning/repair.ts` — defaults for malformed Flash output. Per-iteration: filter empty paragraph, default unknown hypothesis to `null`. Final brief: clamp `iterations` to a valid range, ensure `paragraphs` has at least one entry.

### Orchestrator (self-directing iterative chain)

- `server/src/reasoning/intent-classifier.ts` — keep the existing regex-based `classifyIntent` (rename to `classifyIntentByRegex` for clarity); add new `classifyIntentByChain(prompt, ctx)` that orchestrates the **iterative paragraph chain** modelled on `runIterativeChain` already in `task-reasoner.ts`. Key shape:
  ```ts
  async function classifyIntentByChain(payload): Promise<IntentClassificationBrief | null> {
    const paragraphs: string[] = []
    let lastHypothesis: IntentHint | null = null
    let lastConfidence: "HIGH" | "MEDIUM" | "LOW" | null = null
    let iterations = 0

    for (let i = 0; i < MAX_ITERATIVE_STEPS; i++) {  // MAX = 6, matches preflight
      iterations += 1
      const userTurn = buildIntentClassificationUserTurn(payload, paragraphs, i)
      const raw = await callReasoner({ ...payload, kind: "intent_classification" }, userTurn)
      const step = parseIntentClassificationStep(raw)
      if (!step) break  // unparseable → stop chain; if we have prior paragraphs, settle on the last hypothesis

      // Anti-staleness: the LLM can SUPERSEDE a prior paragraph if it changes its mind.
      if (step.supersedes != null && step.supersedes < paragraphs.length) {
        paragraphs[step.supersedes] = step.paragraph
      } else {
        paragraphs.push(step.paragraph)
      }
      lastHypothesis = step.hypothesis ?? lastHypothesis
      lastConfidence = step.confidence ?? lastConfidence

      if (step.done) break  // LLM committed; we trust its self-directed depth
    }

    if (!lastHypothesis) return null
    return {
      kind: "intent_classification",
      confidence: lastConfidence ?? "LOW",
      intentClassificationBrief: {
        hypothesis: lastHypothesis,
        paragraphs,
        iterations,
        committedVia: paragraphs.length > 0 && iterations < MAX_ITERATIVE_STEPS ? "done_flag" : "step_cap",
      },
    }
  }
  ```
- **Self-directing depth** is the key change vs the previous draft of this plan. There are NO hand-coded "Stage 1 always / Stage 2 on MEDIUM / Stage 3 free-tier" gates. The LLM raises `done: true` when it's ready to commit; the orchestrator respects that. Average case (clean prompts): 1 iteration. Ambiguous case: 2-3. Capped at 6 for runaway protection.
- Fast-path: if `classifyIntentByRegex(prompt)` returns a HIGH-confidence match (continuation phrase, stack-trace shape, bare `ls` / `pwd`), skip the chain entirely. *"Don't burn Flash on prompts that are obvious."*
- Fallback: chain throws / returns null / no reasoner backend → regex. Committed via `regex_fallback` in the telemetry.
- New top-level `classifyIntent(prompt, ctx)` wraps both: tries the chain first when the LLM is available + the regex didn't already commit HIGH, falls back to regex on chain failure.

### Wiring

- `server/src/handlers/user-message.ts` — replace the synchronous `classifyIntent(body.content)` call with the async version. Already in an `async` function so no signature changes; just `await` it.
- `server/src/handlers/tool-result.ts` — same change. Note: tool-result.ts currently classifies on every response (`response.runIntent = classifyIntent(run.content)`) for Phase 19's defense-in-depth. Pure regex was cheap; LLM-per-tool-result would be expensive. Replace with a per-run cache: classify once on the first turn (stash on a per-run map), reuse on every subsequent response. Constant for the run.
- `server/src/reasoning/task-reasoner.ts: pickPipeline` — currently calls `classifyIntent` synchronously. Either thread the async classification result through, or keep `pickPipeline` regex-fast (since the LLM result is already stashed by the time `pickPipeline` runs — the run started with classification, which fed `runIntent`, and `pickPipeline` can read that stashed value).

### Tests

- `server/src/reasoning/__tests__/intent-classification-pipeline.test.ts` (NEW) — fixture-driven tests for the pipeline's prompt structure + per-iteration step shape. Mock the Flash response; assert paragraph + done + hypothesis + confidence + supersedes parse correctly; malformed responses repair to safe defaults.
- `server/src/reasoning/__tests__/intent-classifier-chain.test.ts` (NEW) — **self-directing-depth matrix** (not fixed-stage):
  - HIGH-confidence regex → skip chain entirely (0 Flash calls)
  - LLM iter 1 with `done: true` HIGH → commit after 1 iteration
  - LLM iter 1 `done: false` LOW → iter 2 fires, iter 2 `done: true` → commit after 2
  - LLM keeps `done: false` to the cap → commit `step_cap` with last hypothesis, confidence forced to LOW
  - LLM uses `supersedes` to revise iter 1's paragraph mid-chain → final paragraphs array has the revision
  - Unparseable iteration mid-chain → stop chain, commit with prior hypothesis (or null → regex fallback)
  - All iterations fail / no API key → regex fallback, `committedVia: "regex_fallback"`
- `server/src/reasoning/__tests__/intent-classifier.test.ts` — existing tests stay; renamed export `classifyIntentByRegex` is what they call. Add a new block testing the async `classifyIntent(prompt, ctx)` wrapper with stub LLM that returns specific `{ done, hypothesis, confidence }` shapes.

### Per-run cache

- `server/src/services/intent-cache.ts` (NEW) — tiny per-run map `intentByRun: Map<runId, IntentHint>`. Populated by the first `classifyIntent` call on a run; read on subsequent calls. Cleared on terminal exit (paired with the other per-run state stores).

## Migrations / data

N/A — pure in-memory. No schema changes outside the additive `intentClassificationBriefSchema`.

## Hooks / skills / settings to update

- New flags:
  - `reasoning.intent_classification_via_llm_enabled` (default `true`). Off-switch falls back to regex everywhere.
  - `reasoning.intent_classification_max_iterations` (default `6`). Hard cap on iterative-chain depth (matches `MAX_ITERATIVE_STEPS` for preflight). Operators can lower it (e.g. `3`) if rate-limit pressure on free-tier shows in telemetry, but the LLM's `done` flag drives most short circuits anyway.
  - `reasoning.intent_classification_fast_path_regex_enabled` (default `true`). When false, EVERY classification goes through the LLM chain (useful for telemetry / tuning).
- No `.claude/hooks/` or `.claude/settings.json` changes.

## Dependencies

- Uses the existing `runReasoningChain` helper (Phase 16 Stage 2) — no new dependency.
- Uses the existing `pickReasonerBackend` (Phase D of model-lock) — same backend that serves preflight.
- Zero new npm packages.

## Risks & mitigations

- **Cost: variable Flash calls per turn (1 on average, up to 6 on the ambiguous tail).** Mitigation: per-run cache (classify once, reuse for the rest of the run); regex fast-path for obvious cases (continuation phrases, stack-trace shape); **LLM-self-directed depth** so most prompts commit after iter 1 with `done: true`. Target free-tier overhead: ≤ 1 extra Flash on average; ≤ 3 on the ambiguous tail; 6 is a hard cap (runaway-protection, not a schedule).
- **Latency: each iteration adds ~500-800ms.** Mitigation: parallelise with preflight (run in parallel via `Promise.all` — preflight doesn't actually need the intent until its prompt assembly stage). Same total wall-clock for HIGH-confidence regex hits + clean LLM commits; +2-3 Flash latencies only on genuinely ambiguous prompts where the LLM decides it needs more depth.
- **LLM produces a malformed brief.** Mitigation: `repair.ts` filters / defaults per-iteration; if a SINGLE iteration's output is unparseable, the chain stops and commits with whatever it has (or falls back to regex if it has nothing). Same defensive pattern preflight already uses.
- **Free-tier rate limit eaten by deep iteration chains.** Mitigation: per-run cache caps total intent-classification calls to N (where N is the depth on the first turn). Subsequent turns: zero calls. Off-switch (`reasoning.intent_classification_via_llm_enabled = false`) restores pre-plan behaviour. Operators can also lower `reasoning.intent_classification_max_iterations` to clamp the tail.
- **The LLM gets confused by long prompts and hallucinates a wrong intent.** Mitigation: the pipeline's system prompt explicitly enumerates the four classes + gives 2-3 examples of each (build prompts with error-handling features → implement; error-only prompts → bug; etc.). The senior-engineer rubric requires the LLM to *double-check* (point 5) before committing — that step naturally catches re-readable phrasing.
- **The LLM never marks `done: true` and runs to the cap on every prompt.** Mitigation: the senior-engineer rubric explicitly says *"point 6: DECIDE — commit unless you have a specific question that another pass would answer"*. The system prompt frames hesitation as a failure mode. If telemetry shows average iterations creeping above 2, the prompt gets tuned to push more aggressive commits.
- **Bug-report-style prompts that mention "build" early ("debug the build failure") get classified as implement by the LLM.** Mitigation: the senior-engineer rubric's *"double-check"* step explicitly asks the LLM to re-read the opening verb. The LLM has full prompt context to spot a stack-trace shape or a *"why is X failing"* phrasing the regex would catch. Later iterations can SUPERSEDE earlier paragraphs if the LLM realises it misread.
- **Reasoner backend down + regex fallback is wrong.** Mitigation: PR #82's implement-anchor regex stays IN the regex classifier; the LLM path is ADDITIVE, not REPLACE. Regex remains a tested fallback, not the primary path. Telemetry tracks `committedVia` so the fallback rate is visible.

## Implementation order

1. **Stage 1 — Pipeline + schema.** New `intent-classification-pipeline.ts` + `intentClassificationBriefSchema` + repair defaults + pipeline tests. No call-site changes yet.
2. **Stage 2 — Orchestrator helper.** New `classifyIntentByChain(prompt, ctx)` in `intent-classifier.ts` that uses `runReasoningChain` with 1-3 stages gated on confidence. Falls back to regex on chain failure / no API key. Unit tests for the gate matrix.
3. **Stage 3 — Per-run cache.** New `intent-cache.ts` with `getIntentForRun(runId)` + `setIntentForRun(runId, hint)` + `clearIntentForRun(runId)`. Pattern matches `last-reasoning-store.ts` + `reasonerBackendByRun`.
4. **Stage 4 — Wiring + async migration.** Update `user-message.ts` + `tool-result.ts` to await the new async classifier. Add the per-run cache check before calling the chain. Terminal cleanup clears the cache alongside the other per-run state stores. Defensive: keep `pickPipeline` regex-fast (reads the cache); LLM result is the authoritative source.
5. **Stage 5 — Flags + telemetry.** Register the three new flags. Add `intentClassificationSource: "regex" | "llm-stage1" | "llm-stage2" | "llm-stage3" | "regex-fallback"` to `RunSummary` so telemetry shows the actual path.
6. **Stage 6 — KB docs + plan archive.** New `architecture.md: ## LLM-driven intent classification` subsection. `decisions.md: ## Why LLM intent classification beats regex + what the fallback looks like` entry with the rejected alternatives. Plan archived.

Each stage = one PR off `main`. Stage 1+2 (pipeline + orchestrator) can ship in one PR since they're tightly coupled and the orchestrator can't be tested without the pipeline.

## Verification

**Per stage:** typecheck + npm test green.

**End-to-end:**

- **Test 1 — the verbatim regression case** (the 2026-05-15 POS-app prompt) classified as `implement` by the LLM, not by the implement-anchor regex (so we know the LLM path is what drove it).
- **Test 2 — bug report still classifies as bug.** *"the deploy keeps failing with ENOENT"* → `bug` via LLM.
- **Test 3 — ambiguous prompt triggers self-directed deeper reasoning.** *"make this faster"* (could be implement-optimisation OR bug-investigation) → iter 1 returns `done: false` with an explicit question; iter 2 sees that question + commits.
- **Test 4 — deep iteration chain runs to 3-4 iterations on genuinely contested prompts.** A prompt mixing bug-shape phrasing with feature-list language → iterates with `supersedes` to revise mid-chain → eventually commits with paragraphs[] showing the deliberation.
- **Test 5 — per-run cache.** Send a prompt, observe `intent_classified` event; send a follow-up tool result; observe ZERO additional Flash calls (cache hit).
- **Test 6 — regex fast-path.** `/continue` prompt → regex commits HIGH immediately, no Flash call.
- **Test 7 — fallback.** Unset all reasoner API keys; observe regex-only path; `intentClassificationSource: "regex"` in telemetry.
- **Test 8 — flag off.** `reasoning.intent_classification_via_llm_enabled = false` → regex-only path even when keys are set.
- **Test 9 — latency.** Time the FIRST turn with the chain on vs off; assert the difference is bounded (target ≤ 800ms for Stage 1 only; the chain runs in parallel with preflight).

## Out of scope

- **Replacing the regex entirely.** It stays as the fast-path + fallback. Removing it would leave us no path when no API key is configured.
- **Multi-language intent (the prompt is in Spanish, etc.).** The Flash classifier handles natural language inherently; explicit i18n routing tables are unnecessary. If telemetry shows accuracy regressions on non-English prompts, add a follow-up.
- **Streaming the classification result.** The first response carries `runIntent` exactly like it does today (Phase 19). LLM-as-a-service doesn't change the surface, just the source.
- **Intent classification on tool-result responses.** Per-run cache means the classification happens once at run start. Defending against intent shifting mid-run is out of scope; if a run's character changes that radically, the awareness loop (Phase 11) catches it.
- **A separate "decision" intent class.** The plan keeps the four existing values (`simple | bug | summary | implement`). Adding a fifth class (e.g. `decision` for `/reason` invocations or planning prompts) is a separate plan once we have telemetry on whether the four are enough.
- **Auto-tuning the LLM prompt** based on misclassification telemetry. Manual review of `intentClassificationSource` distribution drives prompt updates for now.

## Notes for implementation

### The system prompt for the pipeline

Must include (verbatim or close to it):

> *"You are an intent classifier. The user has sent you a prompt. Your job is to decide whether they're asking for:*
> - *`simple` — a one-shot read/list/show (e.g. `ls src`, `read foo.ts`, `continue`)*
> - *`bug` — a debugging request (something broken, not working, throwing errors, failing)*
> - *`summary` — an explanation request (explain, summarise, walk me through, what does X do)*
> - *`implement` — a build request (build, create, add, scaffold a feature)*
>
> *You reason ONE paragraph at a time, like a senior engineer thinking out loud. Each paragraph must cover, in flowing prose (NOT a form):*
> 1. ***Restate** what the user is asking, in your own words. Quote their exact phrasing where it matters.*
> 2. ***Why this hypothesis vs alternatives.** Name the next-most-likely classification and why this one wins.*
> 3. ***Trade-offs.** What's the cost if I'm wrong? Mis-classifying a build as a bug forces the user to re-prompt; the inverse runs the implement pipeline on a debug request — different costs.*
> 4. ***End-to-end check.** If I commit to X, what pipeline runs? Would that pipeline produce the right output for this prompt?*
> 5. ***Double-check.** Re-read the prompt's opening verb. Re-read any compound nouns — 'error handling' is a feature, 'error on login' is a symptom. Did I trip on any of those?*
> 6. ***Decide.** Set `done: true` and commit `hypothesis` + `confidence`, OR set `done: false` and end the paragraph with the specific question another pass should answer.*
>
> *A build prompt that mentions error-class words inside its FEATURE LIST is NOT a bug report. 'build a service with error handling, validation, and retry-on-failure' is implement. 'the auth service throws an error on login' is bug. The verb at the START of the prompt matters more than nouns anywhere else.*
>
> *You can revise a prior paragraph by setting `supersedes: N` (zero-indexed). Use this when later context makes you change your mind — DON'T keep stacking paragraphs that contradict each other.*
>
> *Commit when you can. Iterating is for cases where another pass would genuinely add signal. The first paragraph is enough most of the time."*

### Why not just always commit on iter 1?

Because some prompts are genuinely ambiguous. *"make this faster"* could be implement (optimise this code) or bug (it's slow / regressed). *"fix the auth service to support OAuth"* mixes a bug-verb (`fix`) with a feature-add. The senior-engineer rubric handles these gracefully — the LLM sees the ambiguity, raises the question in paragraph 1, addresses it in paragraph 2. Self-directed depth.

### Why max 6?

Matches `MAX_ITERATIVE_STEPS` for the preflight chain. Six paragraphs is more than any genuinely ambiguous classification needs; runs past 4 are a smell. Telemetry on `iterations` distribution will inform whether to lower the default.
