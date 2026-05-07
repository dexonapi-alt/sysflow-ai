# Phase 17 — Adaptive prompts + inferred user preferences

- **Created:** 2026-05-07
- **Scope:** Today the system carries cross-prompt context (`sessionHistory`, `/continue`) and a memory-recall feedback loop, but it does NOT learn from recurring user behaviour. The `kind: "preference"` entry exists in the schema with zero recording paths. Phase 17 builds the inference engine + the conditional prompt-injection so the agent gets perceptibly smarter the more the user uses it.
- **Status:** draft

## Goal

Each new user prompt should arrive in front of an agent that:

1. Remembers what worked last time AND adapts when the user contradicts a prior preference.
2. Notices recurring user behaviour (same language, same style, same answers to the same questions) and adapts WITHOUT being told.
3. Treats a user-typed `/remember "I prefer python"` as one signal among many — not the only path to preference learning.

The end state is a CLI that feels like it's gradually getting tuned to the person using it. Today every prompt starts from zero knowledge of the user. After Phase 17, prompts arrive against a small but growing profile.

## Context from knowledge base

- `architecture.md: ## Living CLI (Phase 12)` — the LEARNED_MEMORY prompt section (priority 106) is where preference entries surface to the model. Already wired. Phase 17 adds preference-shaped entries, doesn't change the section.
- `decisions.md: ## Pure shape functions instead of ink-testing-library` — same pattern: every preference inference helper ships a pure shape function (e.g. `inferLanguagePreference(history)`) so the contract is testable without rendering.
- `gotchas.md: ## Continuation prompts ("continue the task") used to spawn the canned task pipeline` — relevant: the system already routes `/continue` differently. Phase 17's inferred preferences should NOT override an explicit `/continue` (that routes via existing mechanism).
- Phase 8 plan `.claude/plans/2026-05-02-phase-8-persistent-reasoning-memory.md` — declares the `preference` entry kind. Phase 17 is the "wire it up" phase.
- Phase 15 plan `2026-05-07-phase-15-memory-handling-anti-staleness.md` — wires the active-confirmation loop. Phase 17 depends on Phase 15 being merged first so contradictions in inferred preferences propagate.

## Affected files

### Inference engine (the new core)
- `server/src/services/preference-inference.ts` (new) — pure helpers that take recent session history + memory entries and return inferred-preference candidates:
  - `inferLanguagePreference(prompts: string[])` — detect non-English / mixed-language patterns; emits `lang:fr`, `lang:es`, `lang:en` etc.
  - `inferStylePreference(history: SessionRecord[])` — detect "user kept short responses" (response length < 200 chars dominant) → emits `style:brief`; the inverse → `style:verbose`.
  - `inferOutputFormatPreference(toolPattern: string[])` — detect "always uses markdown tables", "always plain lists" etc.
  - `inferDefaultDecisions(decisionHistory: DecisionRecord[])` — detect "user picked option A 3+ times when offered A vs B" → emits `default:A` for that decision class.
  Each helper is pure, testable, returns 0-N preference candidates with a confidence float.

### Inference scheduler
- `server/src/handlers/user-message.ts` — after preflight (so we already have prompt classification + complexity), call `inferAndRecord(prompts, history, memory)`. Inferred preferences with confidence ≥ threshold get `recordPreference()` called on them. Threshold defaults to 0.7 to keep the recorder conservative.

### Memory recorder side
- `server/src/memory-store/recorder.ts` — `recordPreference()` likely already exists per Phase 8's declaration. Verify and wire if missing. Tags should be in the form `["lang:python", "style:brief"]` so the LEARNED_MEMORY section can filter by tag prefix.
- Cross-validation: Phase 15's `applyMemoryFeedback` should respect preference entries (a confirmed preference bumps useCount; a contradicted one trips the kill).

### Prompt section adaptation
- `server/src/providers/prompt/sections/learned-memory.ts` — extend the rendered output to include a small *preferences* sub-block when `kind: "preference"` entries are recalled:
  ```
  ## User preferences (inferred):
  - language: python (confirmed 4×)
  - style: brief
  - default for "use docker?": yes
  ```
  Distinct sub-block so the model can treat these as DIRECTIVES, not facts.
- `server/src/providers/prompt/build.ts` — no change to the section ordering; LEARNED_MEMORY at priority 106 already covers it.

### Adaptive routing (small but high-impact)
- `server/src/handlers/user-message.ts` — when a `lang:X` preference exists with high confidence, prepend a one-liner to the system prompt: "Reply in {language} unless the user explicitly switches." Otherwise no language directive. Same shape for `style:brief`.

### Tests
- `server/src/services/__tests__/preference-inference.test.ts` (new) — pure-helper tests for each inference function. Edge cases: too few samples (returns nothing), conflicting samples (returns the more recent), stable samples (high confidence).
- `server/src/handlers/__tests__/user-message.test.ts` (extend) — schedule-and-record fires; threshold guard works; existing memory entries get bumped, not duplicated.
- `server/src/providers/prompt/__tests__/learned-memory.test.ts` (extend if exists, create otherwise) — preference sub-block renders; absent entries → no sub-block; multi-tag preferences group correctly.

## Migrations / data

N/A. The on-disk format of `.sysflow-memory.md` is unchanged; preference entries use the existing `kind: "preference"` shape.

## Hooks / skills / settings to update

- New flag: `memory.preference_inference_enabled` (default `true`). Off-switch in case inferred preferences become noisy.
- Confidence threshold flag: `memory.preference_inference_threshold` (default `0.7`).
- `.claude/knowledge/architecture.md` — describe the inference engine in the memory subsection.
- `.claude/knowledge/decisions.md` — entry on "explicit-typed `/remember` is a signal among many, not the only path".
- `.claude/skills/knowledge-update/SKILL.md` references — preferences belong in machine memory only when they're cross-project; project-scoped preferences continue to live in `.claude/knowledge/CLAUDE.md` per the existing memex routing rule.

## Dependencies

- **Phase 15 must merge first.** The active-confirmation loop is what keeps inferred preferences from growing stale (a wrong inference gets killed via contradiction). Without Phase 15 the inference engine could grow garbage entries.
- Zero new npm packages.
- No new env vars beyond the flags above.

## Risks & mitigations

- **Inference engine could record privacy-sensitive preferences** (e.g. inferring user's location from prompt content). Mitigation: scope inference to neutral categories — language / style / output format / decision defaults. Don't infer demographic traits, don't store IPs / paths from `/etc`. Hard-code the allowed inference categories.
- **Conflicting preferences across projects.** A user's "brief style" in project A might not apply to project B. Mitigation: preference entries are already per-cwd via the memory store; this is automatic.
- **Stale preferences after the user changes habits.** Mitigation: Phase 15's contradiction loop kicks in. Plus a `preference.max_age_days = 30` policy on inferred preferences — a hard age cap that's tighter than the 60/180-day default for other entries.
- **The model misuses preference directives** (e.g. honours `style:brief` even when the user just asked for a long explanation). Mitigation: preference directives are framed as defaults, not absolutes ("Reply briefly **unless** the user explicitly asks for detail"). The "unless" phrasing matters.
- **Threshold misfires** (inferring a preference from too few samples). Mitigation: the helpers return `null` when sample count < 3; threshold of 0.7 is high enough that a single contradiction per 3-sample inference disqualifies it.
- **Free-tier hallucination of `memoryFeedback` could falsely confirm bad preferences.** Mitigation: Phase 15's cross-validation guard already gates this.

## Implementation order

### Stage 1 — Pure helpers in isolation
1. `preference-inference.ts` with 4 helpers (`inferLanguagePreference`, `inferStylePreference`, `inferOutputFormatPreference`, `inferDefaultDecisions`).
2. Each helper: pure, deterministic, returns `Array<{tag: string, confidence: number, evidence: string[]}>`.
3. Tests for each helper covering empty / few samples / consistent / conflicting / contradicted cases.

### Stage 2 — Scheduler + recorder wiring
1. `inferAndRecord` orchestrator that runs all helpers, filters by threshold, dedups against existing memory entries, then calls `recordPreference()` for new ones.
2. Wire into `user-message.ts` after preflight returns.
3. Tests: scheduler integration ensures only entries above threshold are recorded; existing entries get useCount bumped via Phase 15's confirmation loop.

### Stage 3 — Prompt section preference sub-block
1. Extend `learned-memory.ts` to render a `## User preferences (inferred)` sub-block when preference entries are recalled.
2. Phrase as "tag: value (confirmed N×)" so the model has full context.
3. Tests: rendering with / without preference entries; multi-tag grouping.

### Stage 4 — Language + style directives
1. Detect `lang:X` and `style:brief|verbose` in recalled preferences.
2. Prepend one-liner to system prompt when present and confidence ≥ 0.85.
3. Tests: French preference → system prompt includes language directive; absent → no directive.

### Stage 5 — KB docs + plan archive
1. `architecture.md` — add a "Preference inference" subsection under the memory section.
2. `decisions.md` — entry on inference categories whitelist + threshold rationale.
3. Plan archived to `applied/`.

## Verification

Per stage: typecheck + npm test green.

End-to-end:
- **Test 1 — language inference.** Three consecutive prompts in French; assert a `lang:fr` preference recorded; on the 4th English prompt, language directive does not pull the agent into French (the model's "unless explicitly switched" gating works).
- **Test 2 — style inference.** Three short responses (<200 chars); assert `style:brief` recorded; next prompt's main-model output averages shorter than the agent's pre-Phase-17 baseline.
- **Test 3 — contradiction kills stale preference.** Seed a `style:brief` preference; user explicitly asks for a long explanation; the response is long; Phase 15's contradiction path fires; entry is killed within 2 strikes.
- **Test 4 — flag disables.** Set `memory.preference_inference_enabled = false`; verify no new preference entries are recorded.
- **Test 5 — privacy guardrails.** Feed a prompt with file paths / IPs / personal info; verify the inference engine does NOT record any of those; only the whitelisted categories.

## Out of scope

- Behavioural inference outside the whitelisted categories. No "favourite editor", "timezone", "current task" inference — those are explicit-input territory.
- A user-facing `/preferences list` slash command. Existing `/memory list` already shows all entries including preferences. No new command needed in this phase.
- Cross-machine preference sync. Memory is per-cwd; cross-machine syncing is out of scope for the entire memex memory subsystem.
- Active-prompt rewriting based on the inferred preferences (e.g. "rewrite the user's prompt before sending"). Preferences influence the SYSTEM prompt, not the USER prompt.
- LLM-driven preference inference. Phase 17 is pure-heuristic. A future phase could add a Flash call that proposes preference candidates from longer history; out of scope here.
