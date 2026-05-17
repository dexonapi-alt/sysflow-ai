# Architecture

System-shape facts. Diagram > prose; boundaries > implementation detail.

## Chunked reasoning loop (Phase 10)

- **Source:** plan `applied/2026-05-06-phase-10-chunked-reasoning-loop.md`

Every implement-class run threads through a per-chunk reason → execute → reflect → reason loop instead of one mega-bulk turn. Two cheap Gemini Flash calls (chunk-planner + chunk-reflector) bracket every main-model turn.

```
┌─────────────────────────────────────────────────────────────────┐
│  user_message                                                    │
│       │                                                          │
│       ▼                                                          │
│  preflight reasoning  (Gemini Flash, ~500 tok)                   │
│       │                                                          │
│       │  if pipeline ≠ implement OR ≤3 buildPlan steps           │
│       ├──────────────────────────► legacy single-turn flow       │
│       │                                                          │
│       ▼                                                          │
│  chunk_plan #1        (Gemini Flash, ~500 tok)                   │
│       │   files: [a.js, b.js, c.js]                              │
│       ▼                                                          │
│  main model turn 1   ── HONOURS chunk_plan.files exactly         │
│       │   tool results land                                      │
│       ▼                                                          │
│  chunk_reflect       (Gemini Flash, ~400 tok)                    │
│       │   coherent? issues? shouldStop?                          │
│       │                                                          │
│       │  if shouldStop                                           │
│       ├──────────────────────────► synthesise `completed`         │
│       │                                                          │
│       │  if chunkCount >= max_chunks_per_run (12)                │
│       ├──────────────────────────► synthesise `completed` (cap)  │
│       │                                                          │
│       ▼                                                          │
│  chunk_plan #2        (Gemini Flash, ~500 tok)                   │
│       │   files: [d.js, e.js]                                    │
│       ▼                                                          │
│  main model turn 2 ... (loop)                                    │
└─────────────────────────────────────────────────────────────────┘
```

### Why two separate Flash calls (planner + reflector)

They have different concerns, different cadences, different failure modes. Merging them dilutes both — see `decisions.md: ## Planner ↔ reflector are additive, not merged`.

### Failure modes the loop handles

- **No `GEMINI_API_KEY`** → `runReasoning` returns `null` → handlers degrade to legacy non-chunked flow without aborting the run.
- **Reflector says `shouldStop`** → handler synthesises a `completed` envelope, bypassing the main model.
- **`max_chunks_per_run = 12` cap hit** → synthesise `completed` with a clear cap-hit message; no infinite loops.
- **Trivial-task short-circuit** — when preflight's `implementBrief.buildPlan` has ≤3 steps, the planner is skipped and the legacy single-turn flow runs.

### State + persistence

- `server/src/services/chunk-state.ts` — per-run in-memory `Map<runId, ChunkBoundary[]>`, cleared on terminal exit alongside `clearPipeline()`.
- `server/src/memory-store/recorder.ts: recordChunkSummary()` — persists each chunk's outcome to `.sysflow-memory.md` so `/continue` resumes mid-stream.
- `cli-client/src/agent/usage-log.ts` — per-run `RunSummary` carries `chunkCount` + `flashCallsCount`. Expected ratio ≈ 2 (one plan + one reflect per chunk after the first).

### Key files (one source of truth per concern)

- Schema + Zod: `server/src/reasoning/reasoning-schema.ts` (`chunkPlanBriefSchema`, `chunkReflectionBriefSchema`)
- Pipeline prompts: `server/src/reasoning/pipelines/chunk-plan-pipeline.ts`, `chunk-reflector-pipeline.ts`
- Pipeline routing: `server/src/reasoning/task-reasoner.ts: pickPipeline`
- Loop driver: `server/src/handlers/tool-result.ts` (chunked-loop block before `callModelAdapter`)
- Initial chunk: `server/src/handlers/user-message.ts` (after preflight)
- Prompt injection: `server/src/providers/base-provider.ts: renderChunkPlanSection`
- Kill switch: flag `reasoning.chunked_loop_enabled` (default `true`); cap flag `reasoning.max_chunks_per_run` (default `12`)
- CLI render: `cli-client/src/cli/render.ts: renderChunkProgress`

## Awareness loop (Phase 11)

- **Source:** plan `applied/2026-05-06-phase-11-awareness-and-recovery.md`

The chunked loop catches micro errors per chunk ("import didn't resolve"). The awareness loop catches macro errors *across* chunks ("you've been building Express + MongoDB but the user said Postgres"). Three signal streams feed one per-run confidence tracker; when confidence drops past `awareness.threshold_blocked` (default 30/100), the agent surfaces an off-course modal so the user can continue/backtrack/redirect.

```
┌──────────────────────────────────────────────────────────────────────┐
│  chunk N executes ── tool results land                               │
│       │                                                               │
│       ▼                                                               │
│  chunk_reflect (Phase 10 reflector)                                   │
│       │                                                               │
│       │  (awareness branch — gated by `awareness.enabled`)            │
│       │                                                               │
│       ├──► heuristic detector (pure, in-memory)                       │
│       │      6 signals: same_file_edit, repeated_tool_error,          │
│       │      mkdir_empty, intent_keyword_absent, scope_creep,         │
│       │      completion_claims_unwritten_files                        │
│       │                                                               │
│       ├──► verification gate (4 disk-side checks, parallel <1s)       │
│       │      import_resolves, deps_cross_check, node_syntax,          │
│       │      dir_emptiness                                            │
│       │                                                               │
│       └──► LLM divergence (Flash, ~300 tok)                           │
│              fires when heuristics flag OR every 2nd chunk            │
│              compares files-modified against the LITERAL prompt       │
│              (anchored via `original_intent` memory entry)            │
│              emits one `llm_off_track` signal when onTrack=false      │
│                                                                       │
│  signals merge → confidence-tracker.recordSignals()                   │
│       │   weighted decay; threshold derived per-call                  │
│       ▼                                                               │
│  getThresholdState()  ── 'on_track' / 'off_course' / 'blocked'        │
│       │                                                               │
│       │  if blocked                                                   │
│       ├──────► waiting_for_user with awarenessChoice + evidence       │
│       │            cli renders off-course modal (3 keys)              │
│       │            backtrack: rollbackToChunk(lastGoodChunkIndex)     │
│       │                                                               │
│       │  if on_track / off_course                                     │
│       ▼                                                               │
│  awarenessSnapshot stamped on response → cli renders badge inline    │
│                                                                       │
│  chunk_plan → chunk N+1 executes (loop)                               │
└──────────────────────────────────────────────────────────────────────┘
```

### Composition with Phase 10 (additive, not merged)

Heuristic + gate + LLM divergence run as **three peer signal sources**, not chained. See `decisions.md: ## Awareness signal sources are peers, not chained`. Each signal contributes a weighted decay independently; the tracker is the only place that sees their union.

### Failure modes the loop handles

- **No `GEMINI_API_KEY`** → LLM divergence half short-circuits at the trigger gate; heuristic + gate keep firing on their own. Detection survives without Flash.
- **`awareness.enabled = false`** → entire awareness branch in `tool-result.ts` is skipped; chunked loop runs as Phase 10 only.
- **Confidence cooldown after user resolution** → 2-chunk mute (`POST_RESOLUTION_COOLDOWN_CHUNKS`) prevents `continue the task` from immediately re-firing the same modal.
- **Per-run LLM cap** → `MAX_LLM_DIVERGENCE_PER_RUN = 8` bounds Flash quota even if heuristics keep flagging.
- **Backtrack on a non-git cwd** → `rollbackToChunk` returns `false` cleanly; cli surfaces a warning and continues with the agent's current state instead of pretending success.

### Free-model heightened sensitivity (Phase 11 Stage 7)

Free-tier models (`openrouter-auto` / `llama` / `mistral` / `gemini-flash-or`) are exactly where the macro-error problem hits hardest. `getThresholdState` accepts an optional `model` arg and bumps both thresholds by `FREE_MODEL_SENSITIVITY_BUMP = 10` when the model matches `isFreeTierModel(model)`. Net effect: a free-tier run hits `off_course` at confidence 70 and `blocked` at 40 (vs. 60 / 30 on a paid model). Paid models keep the gentler defaults — the awareness modal stays a rare event for them.

### State + persistence

- `server/src/services/confidence-tracker.ts` — per-run in-memory `Map<runId, ConfidenceState>`. Cleared on terminal exit alongside `clearChunkState`.
- `server/src/memory-store/recorder.ts: recordOriginalIntent()` — persists the verbatim user prompt to `.sysflow-memory.md` once per new run. The LLM divergence pipeline reads this back so it compares against the LITERAL ask, not the preflight brief's interpretation.
- `cli-client/src/agent/usage-log.ts` — per-run `RunSummary` carries `divergenceDetections`, `divergenceConfidenceAvg`, `autoPauseEvents` so the loop's behaviour is observable on disk.
- `cli-client/src/agent/git.ts` — `Map<runId, ChunkSnapshot[]>` queue separate from Phase 7's single-snapshot store. `createChunkSnapshot` runs before each chunk's tools execute; `rollbackToChunk(lastGoodChunkIndex)` is invoked by the cli when the user picks `b` in the modal.

### Key files (one source of truth per concern)

- Detector (heuristic): `server/src/services/divergence-detector.ts`
- Tracker: `server/src/services/confidence-tracker.ts`
- Verification gate: `server/src/services/verification-gate.ts`
- LLM pipeline: `server/src/reasoning/pipelines/divergence-pipeline.ts`
- Loop driver: `server/src/handlers/tool-result.ts` (awareness block after `chunk_reflect`)
- Off-course modal: `cli-client/src/cli/off-course-prompt.ts`
- Snapshot queue: `cli-client/src/agent/git.ts` (`createChunkSnapshot` / `rollbackToChunk`)
- Memory anchor: `recordOriginalIntent` in `server/src/memory-store/recorder.ts`
- Kill switch: `awareness.enabled` (default `true`); thresholds `awareness.threshold_off_course` (60), `awareness.threshold_blocked` (30)
- CLI badge: `cli-client/src/cli/render.ts: renderConfidenceBadge`

## Active memory loop (Phase 15)

- **Source:** plan `applied/2026-05-07-phase-15-memory-handling-anti-staleness.md`

Phase 8 built the memory store half (entries, validators, recall, compaction). Phase 15 wires the active half — every turn now records what was decided, cross-validates the model's claims about which entries it used / contradicted, and anchors awareness on the LITERAL original prompt instead of the preflight brief's interpretation.

```
┌──────────────────────────────────────────────────────────────────────┐
│  WRITE side  ── handlers fire recorders during a run                  │
│                                                                       │
│  user-message.ts (preflight)                                          │
│    HIGH/MED implementBrief  →  recordImplementSummary                 │
│    HIGH/MED bugBrief        →  recordBugPattern (with confidence)     │
│    HIGH/MED decisionBrief   →  recordDecision                         │
│    LITERAL prompt           →  recordOriginalIntent                   │
│                                                                       │
│  routes/reason.ts (self_invoked)                                      │
│    Non-LOW decisionBrief    →  recordDecision                         │
│                                                                       │
│  tool-result.ts (on_error / on_completion / off_course)               │
│    on_error bugBrief        →  recordBugPattern (with confidence)     │
│    on_completion summary    →  recordImplementSummary (w/ confidence) │
│    Backtrack / redirect     →  recordUserCorrection                   │
│    Each chunk's outcome     →  recordChunkSummary (Phase 10)          │
│                                                                       │
│  Each recorder: LOW skip → secret-pattern guard → SHA256 dedup        │
│                                                                       │
├──────────────────────────────────────────────────────────────────────┤
│  ACTIVE CONFIRMATION  ── per-response feedback loop                   │
│                                                                       │
│  System prompt (LEARNED_MEMORY section)                               │
│    Renders [<id>] kind: content lines + a feedback contract block:    │
│      "memoryFeedback": {                                              │
│        "confirmed":   ["<id>", …],   // ids you used                  │
│        "contradicted": ["<id>"]      // ids you disagreed with        │
│      }                                                                │
│                                                                       │
│  Model response (any turn)                                            │
│    JSON shape carries memoryFeedback alongside taskPlan               │
│         │                                                             │
│         ▼                                                             │
│  base-provider.ts: extractMemoryFeedback(json)                        │
│    Defensive shape filter → null OR {confirmed, contradicted}         │
│         │                                                             │
│         ▼                                                             │
│  handler: applyMemoryFeedback(cwd, feedback, responseText)            │
│    For each confirmed id:                                             │
│      validateConfirmation(entry.content, responseText)                │
│      ≥ 30% token overlap (dash-split, stopword-stripped)              │
│        ✓ → noteAgreement (useCount + lastConfirmedAt bumped)          │
│        ✗ → rejected (audit log only)                                  │
│    For each contradicted id:                                          │
│      validateContradiction(id, responseText)                          │
│      response must contain `[<id>]` in bracket notation               │
│        ✓ → noteContradiction (advances toward 2-strike kill)          │
│        ✗ → rejected (audit log only)                                  │
│    Gated by `memory.active_confirmation_enabled` (default true)       │
│                                                                       │
├──────────────────────────────────────────────────────────────────────┤
│  ORIGINAL-INTENT ANCHOR  ── divergence reads from memory              │
│                                                                       │
│  tool-result.ts (awareness block)                                     │
│    recallForReasoning({ kind: "original_intent" })                    │
│         │                                                             │
│         ▼                                                             │
│  pickDivergenceAnchor(run.content, candidates)                        │
│    run.content ≥ 30 chars  → use it verbatim                          │
│    run.content < 30 chars  → fall back to longest original_intent     │
│         │                                                             │
│         ▼                                                             │
│  detectDivergence + Flash divergence pipeline both anchor on          │
│  the chosen prompt, so /continue + fix-request follow-ups still       │
│  compare implementation against the canonical project intent.         │
└──────────────────────────────────────────────────────────────────────┘
```

### Cross-validation guards

The model's `memoryFeedback` field is treated as a CLAIM, not a fact. Free-tier models hallucinate "confirmed: [abc123]" for entries they never used and "contradicted: [def456]" without any actual disagreement. Two guards:

- **`validateConfirmation`** — token overlap ≥ 0.3. Catches the obvious "completely unrelated response claims to use this entry" case. False positives cost a single bumped useCount; false confirms accumulate noise that future recall promotes — so the threshold matters.
- **`validateContradiction`** — response MUST contain `[<id>]` in bracket notation (the same notation LEARNED_MEMORY renders). Stricter than overlap because killing an entry is irreversible after 2 strikes; this forces the model to point at exactly which entry it's disagreeing with.

Both guards are pure functions, exported, and tested in isolation. The handler-side `applyMemoryFeedback` returns a per-id audit log (`confirmedHonoured / confirmedRejected / contradictedHonoured / contradictedRejected`) so telemetry can surface hallucination rates.

### Failure modes the loop handles

- **No memory entries** → recall returns empty; LEARNED_MEMORY section + contract block are not rendered (no prompt overhead); `applyMemoryFeedback` is a no-op.
- **Model omits `memoryFeedback`** → `extractMemoryFeedback` returns null; helper short-circuits; no state changes.
- **Malformed payload** (numbers, nulls, non-arrays in the lists) → defensive filtering normalises to clean shape or null.
- **Hallucinated ids** → entries-by-id lookup fails; audit log records as `*Rejected`; no `note*` call fired.
- **Hallucinated confirms** (no overlap) → cross-validation rejects; no useCount bump.
- **Fabricated contradictions** (no `[id]` reference) → cross-validation rejects; no contradictionCount advance.
- **Recall failure during anchor pick** → divergence falls back to today's `run.content` behaviour; no regression.
- **`memory.active_confirmation_enabled = false`** → the helper is never called; recorder coverage half (Stages 1-2) keeps working.

### Key files (one source of truth per concern)

- Recorder API: `server/src/memory-store/recorder.ts` (`recordDecision` / `recordImplementSummary` / `recordBugPattern` / `recordUserCorrection` / `recordChunkSummary` / `recordOriginalIntent`)
- Confirmation tracker: `server/src/memory-store/confirmation-tracker.ts` (`noteAgreement` / `noteContradiction`)
- Active feedback helper: `server/src/memory-store/feedback.ts` (`applyMemoryFeedback`, `validateConfirmation`, `validateContradiction`)
- Prompt section: `server/src/providers/prompt/sections/learned-memory.ts` (renders entries + feedback contract block)
- Response extraction: `server/src/providers/base-provider.ts: extractMemoryFeedback`
- Anchor picker: `server/src/services/divergence-detector.ts: pickDivergenceAnchor`
- Apply call sites: `server/src/handlers/user-message.ts` + `server/src/handlers/tool-result.ts` (after model adapter returns)
- Original-intent reader: `server/src/handlers/tool-result.ts` (awareness block, before `detectDivergence`)
- Kill switch: flag `memory.active_confirmation_enabled` (default `true`)
- Schema: `NormalizedResponse.memoryFeedback?: { confirmed?: string[]; contradicted?: string[] } | null` in `server/src/types.ts`

## Free-tier policy + chained reasoning (Phase 16)

- **Source:** plan `applied/2026-05-07-phase-16-deep-reasoning-on-free-models.md`

Phase 5 added 7 reasoning triggers, all single-shot Flash. Phase 11 introduced `isFreeTierModel` + `FREE_MODEL_SENSITIVITY_BUMP` for confidence thresholds. Phase 16 promotes free-tier adaptation into a **central policy module** + adds **chained Flash within a concern** so cheap models compensate for the depth gap they have vs paid models. Three new chains land alongside one new policy file.

```
┌──────────────────────────────────────────────────────────────────────┐
│  free-tier-policy.ts  ── single source of truth for free-tier knobs  │
│                                                                       │
│  Constants:                                                           │
│    FREE_MODEL_SENSITIVITY_BUMP = 10  (Phase 11; +bump on thresholds) │
│    FREE_TIER_DIVERGENCE_CHAIN_LOWER/UPPER = 40 / 60                  │
│    FREE_TIER_CHUNK_CAP_TIGHTEN = 0.7   (12 chunks → 8)               │
│    FREE_TIER_CHUNK_FILES_TIGHTEN = 4    (5 files → 4)                │
│                                                                       │
│  Pure helpers:                                                        │
│    isFreeTierModel(model)                                             │
│    shouldRunPreflightElaboration({model, complexity, conf, flag})     │
│    shouldRunDivergenceSecondLook({model, score, flag})                │
│    resolveMaxChunksPerRun(model, baseMax)                             │
│    resolveMaxFilesPerChunk(model)                                     │
│    resolveChunkCaps(model, baseMax)                                   │
└──────────────────────────────────────────────────────────────────────┘
            │                                       │
            │ used by                               │ used by
            ▼                                       ▼
┌──────────────────────────────────┐    ┌──────────────────────────────┐
│  Chained preflight (Stage 3)     │    │  Chained divergence (Stage 4)│
│                                  │    │                              │
│  user-message.ts                 │    │  tool-result.ts (awareness)  │
│  preflight Flash → implement     │    │  detectDivergence + Flash    │
│       │                          │    │       │                      │
│       │ gate: free + complex≥med │    │       │ gate: free + score   │
│       │       + conf<HIGH        │    │       │       in [40, 60]    │
│       ▼                          │    │       ▼                      │
│  implement_elaborate Flash       │    │  divergence_check Flash      │
│    whyThisApproach +             │    │    (with priorVerdict in     │
│    whyNotAlternative +           │    │     context)                 │
│    preconditions +               │    │       │                      │
│    re-scored confidence          │    │       │ second verdict       │
│       │                          │    │       │ replaces first       │
│       ▼                          │    │       ▼                      │
│  Plumbed into prompt:            │    │  Confidence tracker sees     │
│    "DEEPER REASONING"            │    │  the deeper verdict's        │
│    sub-block under the           │    │  mismatches/score/suggestion │
│    implement brief               │    │                              │
└──────────────────────────────────┘    └──────────────────────────────┘
            │                                       │
            ▼                                       ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Tightened chunk caps (Stage 5) — applied at every chunk_plan slice  │
│                                                                       │
│  user-message.ts initial chunk:                                       │
│    files = files.slice(0, resolveMaxFilesPerChunk(model))             │
│  tool-result.ts subsequent chunks:                                    │
│    files = files.slice(0, resolveMaxFilesPerChunk(model))             │
│  tool-result.ts cap check:                                            │
│    if activeChunks >= resolveMaxChunksPerRun(model, baseMax) → stop   │
│                                                                       │
│  Net effect on a free-tier run:  12 chunks → 8 ; 5 files → 4         │
└──────────────────────────────────────────────────────────────────────┘
```

### Chain helper (Phase 16 Stage 2)

`server/src/reasoning/chain.ts: runReasoningChain(original, stages, runner?)` — pure orchestrator. Each stage's `buildPayload(prior, original)` receives the prior non-null brief + the original payload; returning null skips that stage cleanly. Defensive against throws — `buildPayload` and `runReasoning` failures are logged and recorded as null briefs in the audit; the chain continues with the prior brief intact. Per-call telemetry stays per-call (chain doesn't add a counter; each successful runReasoning hits usage-log on its own).

### Schema additions

- `triggerSchema` adds `"implement_elaborate"` (Stage 3 trigger).
- `pipeline` enum adds `"implement_elaborate"` with matching `implementElaborationBriefSchema`.
- `assertEnvelopeShape` covers the new pipeline.
- `NormalizedResponse.memoryFeedback` (Phase 15) and `NormalizedResponse.reasoningElaborationBrief` (Phase 16 Stage 3) are both untyped on the payload to avoid import cycles; providers cast at the seam.

### Failure modes the loop handles

- **No `GEMINI_API_KEY`** → both chains short-circuit at the runReasoning trigger gate; first-pass calls fall back to legacy single-stage behaviour.
- **Free-tier rate limit (429)** → existing retry budget in `task-reasoner.ts` absorbs occasional hits; the chain's second stage inherits it. Sustained 429s prompt the user to flip `reasoning.chained.preflight_elaboration_enabled` off via the flag system.
- **Borderline divergence band edge** → 39 = decisive off-course (no second look needed); 61 = decisive on-track (no second look needed); only the [40, 60] band routes through the chain.
- **Tiny `max_chunks_per_run` base** (e.g. operator sets it to 1) → `resolveMaxChunksPerRun` floors to 1 so free-tier runs still work, just not multi-chunk.
- **Schema cap stays 5** → if a free-tier `chunk_plan` brief ever returns 5 files, the slice in the handler trims to 4. The schema is permissive; the policy is strict.

### Free-tier overhead budget

Phase 16 plan target: free-tier `flashCallsCount` ≤ 1.7× current. Gate-driven additions:

| Stage | When it fires (free-tier only) | Extra Flash calls |
|---|---|---|
| 3: chained preflight | preflight confidence < HIGH AND complexity ≥ medium | +1 per turn |
| 4: divergence second-look | first verdict score in [40, 60] | +1 per chunk where first fires |
| 5: chunk caps | (no extra Flash — just slices outputs) | 0 |

HIGH-confidence preflights and simple tasks add zero overhead. Decisive divergence verdicts (≤39, ≥61) add zero. Real ratio depends on how often free-tier preflights land below HIGH; measure via `flashCallsCount` once telemetry from Stages 3-4 is in.

### Key files (one source of truth per concern)

- Policy module: `server/src/services/free-tier-policy.ts` (constants + 5 pure helpers)
- Chain helper: `server/src/reasoning/chain.ts: runReasoningChain`
- Elaborate pipeline: `server/src/reasoning/pipelines/implement-elaborate-pipeline.ts`
- Pipeline routing: `server/src/reasoning/task-reasoner.ts: pickPipeline` + `server/src/reasoning/pipelines/index.ts`
- Schema: `server/src/reasoning/reasoning-schema.ts` (`implementElaborationBriefSchema` + `"implement_elaborate"` trigger/pipeline)
- Stage 3 wiring: `server/src/handlers/user-message.ts` (after preflight, before chunk_plan)
- Stage 4 wiring: `server/src/handlers/tool-result.ts` (awareness block, after first divergence verdict)
- Stage 5 wiring: same handlers (initial + subsequent `chunk_plan` slice + cap check)
- Prompt plumbing: `server/src/types.ts` (`reasoningElaborationBrief` field) + `server/src/providers/gemini.ts` + `server/src/providers/prompt/sections/reasoning-brief.ts` (`DEEPER REASONING` sub-block)
- Kill switches: `reasoning.chained.preflight_elaboration_enabled` (default true) + `reasoning.chained.divergence_second_look_enabled` (default true)
- Back-compat: `server/src/services/confidence-tracker.ts` re-exports `isFreeTierModel` + `FREE_MODEL_SENSITIVITY_BUMP` so Phase 11 importers don't move

## Living CLI (Phase 12)

- **Source:** plan `applied/2026-05-07-phase-12-living-cli-ui.md`

The Ink renderer in `cli-client/src/ui/` is composed of three persistent zones plus a stream zone in the middle. Every visible element has vital signs — colour shifts smoothly between states, the cursor breathes at idle, tool calls render as living cards instead of log lines.

```
┌──────────────────────────────────────────────────────────────────────┐
│  Header  (sticky)                                                    │
│    sys · folder · model · chat · user · [aware badge] · [chunk pulse]│
│                                                                       │
│  AgentStream  (scrolls)                                              │
│    log lines (Static — no per-frame redraw)                          │
│    settled tool cards (Static)                                       │
│    running tool cards (live region; Shimmer / Pulse ticking)         │
│    pending assistant message (Typewriter, key'd to re-mount)         │
│    spinner (Breath on a single glyph)                                │
│                                                                       │
│  ChatInput                                                           │
│    > rotating placeholder hint   (Fade-in keyed on hintIndex)        │
│      cursor ▏                    (Breath at idleBpm)                 │
│                                                                       │
│  LiveStatusBar  (sticky)                                             │
│    ◦ working · 0:42                                                  │
│    Breath tempo follows agent state (active 60bpm / idle 20bpm)      │
└──────────────────────────────────────────────────────────────────────┘
```

### Animation engine (`cli-client/src/ui/animation/`)

Single visual metaphor: **breath**. Slow enough never to strobe, organic enough never to feel mechanical, three tempos (`activeBpm = 60`, `idleBpm = 20`, `modalBpm = 40`).

- **`useFrame`** — one shared 30fps scheduler across all subscribers. Auto-starts on first attach, auto-stops on last detach. Motion-disabled mode emits exactly one settled tick then never again. Lazy-registers the motion-store listener so test resets survive.
- **Easings** — `breath` (cos-loop), `cubicOut` (settle), `elasticOut` (modal land), `linear` (explicit identity).
- **`color-lerp`** — HSL interpolation between hex colours. Walks the SHORT arc of the hue wheel so green→red goes via yellow, not muddy brown. Truecolor when `chalk.level >= 3`; nearest-256 fallback (4 discrete stops) otherwise.
- **Primitives** — `<Breath>`, `<Pulse>`, `<Shimmer>`, `<Fade>`, `<Typewriter>`. Each ships a pure shape function (`computeBreathColor`, `computePulseColor`, etc.) so the visual contract is testable without rendering Ink.

### Event flow (agent ↔ Ink)

The Ink reducer (`cli-client/src/ui/hooks/useAgentEvents.ts`) consumes a typed event union from `cli-client/src/agent/events.ts`. The agent emits structured events (behind `isInkActive()`) at the points the renderer needs them:

```
agent.ts                                  →  events.ts        →  reducer            →  component
────────────────────────────────────────────────────────────────────────────────────────────────
spinner.start("...")                      →  spinner          →  spinnerText        →  Spinner / LiveStatusBar
spinner.stop()                            →  spinner_stop     →  spinnerText=null   →
surfaceToolCall(...) wrap                 →  tool_start       →  toolCards push     →  ToolCard (running)
                                          →  tool_end (ok=t)  →  status=success     →  ToolCard (success)
                                          →  tool_end (ok=f)  →  status=error       →  ToolCard (error)
chunkPlanBrief arrives                    →  chunk_plan       →  chunk pulseKey++   →  Header chunk pulse
awarenessSnapshot arrives                 →  awareness_update →  awareness state    →  Header badge
renderCompletion message                  →  assistant_message →  pending key++     →  AgentStream Typewriter
```

The bus is uni-directional (`emitAgent` only). The cli's input loop (`useInput` in ChatInput) is the only path the user pushes data back through.

### Failure modes the loop handles

- **`SYS_INK` unset** → `isInkActive()` returns false; structured events are not emitted; legacy `console.log` rendering carries on; nothing in `cli-client/src/ui/` is mounted.
- **`--no-motion` / `SYS_NO_MOTION=1`** → `isMotionEnabled()` is false; every primitive renders its child raw at the destination colour; `useFrame` emits one tick then exits; the cli is fully readable but stops moving.
- **Truecolor unavailable** → `chalk.level <= 2`; `color-lerp` snaps to discrete stops (default 4 between any two endpoints) so banded colour replaces smooth gradient. Visual feel degrades but the design is intact.
- **Slow terminals / SSH** → 30fps cap on `useFrame`; settled tool cards move into Ink's `<Static>` so they don't re-render; only the active card + spinner + cursor tick per frame.

### Key files (one source of truth per concern)

- Animation primitives: `cli-client/src/ui/animation/primitives/`
- Animation engine: `cli-client/src/ui/animation/use-frame.ts`
- Easings + colour lerp: `cli-client/src/ui/animation/{easings,color-lerp}.ts`
- Theme tokens: `cli-client/src/ui/theme.ts` (palette, tempo, easing, gradient, spacing, awarenessColor)
- Motion store: `cli-client/src/ui/state/motion.ts`
- Event bus + types: `cli-client/src/agent/events.ts`
- Reducer: `cli-client/src/ui/hooks/useAgentEvents.ts`
- Components: `cli-client/src/ui/components/{Header,LiveStatusBar,AgentStream,ToolCard,Spinner,ChatInput}.tsx`
- Composition root: `cli-client/src/ui/App.tsx`
- Kill switches: env `SYS_INK=1` to mount Ink; `--no-motion` flag or `SYS_NO_MOTION=1` to freeze animations

## Premium CLI components (Phase 14)

- **Source:** plan `applied/2026-05-07-phase-14-premium-cli-experience.md`

Phase 14 polished the renderers within Phase 12's zone layout — no architectural change, just a tighter rendering vocabulary so the live screen reads as polished as Claude Code's session view. New components live alongside the Phase 12 ones in `cli-client/src/ui/components/` and consume the same event bus + reducer.

```
┌──────────────────────────────────────────────────────────────────────┐
│  Header  (sticky — Phase 12; second slash-command row REMOVED)       │
│    sys · folder · model · chat · user · [aware badge] · [chunk]      │
│                                                                       │
│  AgentStream  (scrolls)                                              │
│    log lines (Static)                                                │
│    settled <ActionCard>s (Static)        ← Phase 14: ●-bullets       │
│    running <ActionCard>s (live; bullet pulses while running)         │
│    pending <Typewriter> assistant message                            │
│    <ReasoningPeek> (Phase 14 — `✦ Reasoning(implement)` + summary)   │
│    <RichSpinner> (Phase 14 — single glyph + colour rotation)         │
│                                                                       │
│  ChatInput                                                           │
│    > rotating placeholder hint   (Fade-in keyed on hintIndex)        │
│      cursor ▏                    (Breath at idleBpm)                 │
│      [inline ↑ history hint REMOVED — moved to InteractiveHints]     │
│                                                                       │
│  <InteractiveHints>  (Phase 14 — between ChatInput + LiveStatusBar)  │
│    ↑ history · / commands · tab complete · ctrl+c exit   (idle)     │
│    ctrl+c cancel                                          (working)  │
│                                                                       │
│  LiveStatusBar  (sticky — Phase 12)                                  │
│    ◦ working · 0:42                                                  │
└──────────────────────────────────────────────────────────────────────┘
```

### Component additions

- **`<ActionCard>`** (`components/ActionCard.tsx`) — replaces the bordered `<ToolCard>`. Renders `● Verb(target)` headers (Bash for `run_command`, Update for `edit_file`, Write for `write_file`, Read for `read_file`, Search for `grep` / `glob`) plus an optional `⎿ Added X lines, removed Y lines` summary. NO surrounding box. Settled cards move to `<Static>` so only the running one re-renders per frame.
- **`<RichSpinner>`** (`components/RichSpinner.tsx`) — three regions on one row: a single colour-shifting star glyph (`✢` purple → `✺` teal → `✣` blue → `✤` green, swapped every 250ms at 60bpm), the cycling verb, and a `(elapsed · ↑ tokens)` overlay shown after ≥1s. Re-exported as `<Spinner>` for back-compat; the old single-glyph component is preserved as `<MiniSpinner>` for low-density slots.
- **`<ReasoningPeek>`** (`components/ReasoningPeek.tsx`) — surfaces the latest Flash reasoning brief above the spinner so the user sees what the agent reasoned about while it's still working. Pure `formatBriefSummary(kind, briefData)` extracts 1-3 lines per pipeline (`implement` / `bug` / `decision` / `summary` / `divergence` / `chunk_plan` / `chunk_reflect` / `simple+unknown`); a `Pulse` on the `✦` marker re-fires per emission via the brief's `key`.
- **`<InteractiveHints>`** (`components/InteractiveHints.tsx`) — always-visible bottom row that swaps `idle` ↔ `working` based on `spinnerText !== null`. Pure `pickHints(state)` + `formatHints(hints)` live in `state/hints.ts` so the table is testable and a future state (Phase 11 `awaiting_modal`, future `ctrl+o expand`) is a one-line addition.

### New event types

The Phase 12 event union grew with two slots and one extension:

| Event                        | Reducer slot          | Purpose                                                                                |
|------------------------------|-----------------------|-----------------------------------------------------------------------------------------|
| `tool_start { args? }`       | `toolCards[].args`    | Phase 14: pass tool args along so `<ActionCard>` can derive `Verb(target)` cli-side    |
| `reasoning_brief { kind, briefData }` | `reasoningBrief { kind, briefData, key }` | Drives `<ReasoningPeek>`. `key` increments per emission so the marker Pulse re-fires |

### Gating helpers (Phase 14 Stage 1)

`cli-client/src/agent/events.ts: shouldRenderInlineForLegacy()` — the canonical predicate `!isInkActive()`. Every `agent.ts` callsite that used to print a heavy box / write raw `\x1b[nA` cursor-up escapes / re-render the SUMMARY twice now goes through this gate so the legacy console path keeps working but Ink mode is the single source of truth in the live region.

### Key files (one source of truth per concern)

- ActionCard: `cli-client/src/ui/components/ActionCard.tsx` (+ pure `verbFor`, `formatActionHeader`, `truncateTarget`)
- RichSpinner: `cli-client/src/ui/components/RichSpinner.tsx` (+ pure `pickPrimaryGlyph`, `formatTokens`, `VERBS`, `SPINNER_GLYPHS`, `SPINNER_COLORS`)
- ReasoningPeek: `cli-client/src/ui/components/ReasoningPeek.tsx` (+ pure `formatBriefSummary`)
- InteractiveHints: `cli-client/src/ui/components/InteractiveHints.tsx` (+ pure `deriveHintState`)
- Hints table: `cli-client/src/ui/state/hints.ts` (`pickHints`, `formatHints`, `HINT_TABLE`)
- Legacy gating predicate: `cli-client/src/agent/events.ts: shouldRenderInlineForLegacy()`

## Command-first investigation

- **Source:** plan `applied/2026-05-13-command-first-investigation.md`

For non-trivial implement/bug runs, the agent's default mode of context-gathering is `run_command` (shell), not `read_file`. Files are read only when the agent is about to edit them. Each command result feeds the next via per-turn `reasoningChain[]` prose so the agent's mental model is built from short, factual command output rather than long-file skim-and-hallucinate.

```
┌────────────────────────────────────────────────────────────────────────┐
│  user_message  →  preflight reasoner produces implementBrief / bugBrief │
│                   (incl. investigationPlan: [{ command, expectedSignal,│
│                    pivotIf }] up to 6 entries)                          │
│       │                                                                  │
│       ▼                                                                  │
│  main model: dispatches first `run_command` from investigationPlan       │
│       │                                                                  │
│       ▼                                                                  │
│  cli executor: auto-approves if isSafeReadOnlyCommand matches the        │
│                 whitelist (`git status`, `ls`, `grep`, `find`, `cat`,    │
│                 `npm list`, etc.) — no permission prompt. Increments     │
│                 `investigationCommandsCount` (Stage 5 telemetry).        │
│       │                                                                  │
│       ▼                                                                  │
│  server: command output lands in tool-result                             │
│       │                                                                  │
│       ▼                                                                  │
│  main model emits next response with:                                    │
│       reasoningChain: [\"output revealed X\", \"so my assumption Y is\",  │
│                         \"next I'll probe Z to disambiguate\"]            │
│       tool: run_command  (or read_file once a target file is identified) │
│       │                                                                  │
│       └─── repeat command → reasoning → command → ... → first write ─┐  │
│                                                                       │  │
│                                                                       ▼  │
│           investigation phase ends; implementation phase begins.        │
└────────────────────────────────────────────────────────────────────────┘
```

### Five guardrails working together (each catches a different failure)

1. **Prompt directive** (`prompt/sections/tools.ts` + `task-guidelines.ts` + new `investigation.ts`) frames `run_command` as the PRIMARY context-gathering tool; `read_file` only for files about to be edited. Platform-aware command examples via `env-info.ts`.
2. **Per-turn `reasoningChain[]`** on the `needs_tool` envelope — the agent reasons in prose between every command, not just at preflight. Surfaces in `<ReasoningPeek>` so the user sees the deliberation happen.
3. **Safe-command allowlist** (`cli-client/src/agent/safe-commands.ts: isSafeReadOnlyCommand`) — regex whitelist of read-only investigation commands. Auto-approved in permissions; settable via `commands.auto_approve_safe` setting.
4. **`investigationPlan` brief field** on implement/bug briefs — preflight reasoner suggests 3-5 commands BEFORE writing. Confidence-aware framing: HIGH → MUST run; LOW → suggested.
5. **`no_investigation_before_write` divergence heuristic** + **investigation budget** — soft signal when the agent writes before exploring (Phase 11 awareness); `getInvestigationBudget` caps runaway investigation per tier/intent/complexity. Trivial tasks (`complexity === "simple"`) cap at 1 command.

### Trivial-task short-circuit

The LLM gauges depth via the same instruction Stage C of model-lock baked into `DEEP_REASONING_PROMPT` — *"be smart, don't manufacture investigation where none is needed."* Below the LLM is the system safety net: `getInvestigationBudget` returns 1 for `complexity === "simple"`, latching the budget reminder to fire if the model insists on probing past it. *"Add a `console.log` to line 42"* gets one command at most.

### Telemetry (Stage 5)

- `cli-client/src/agent/agent.ts` counts safe-read-only `run_command` calls at dispatch — both single-tool and batch paths route through `isSafeReadOnlyCommand`.
- Recorded as `RunSummary.investigationCommandsCount`; `usage.jsonl` emits per-run.
- The `[BUDGET]` reminder is logged on the server side; the CLI's counter tracks the *behaviour*, not the reminder count.

### Key files (one source of truth per concern)

- Safe-command allowlist: `cli-client/src/agent/safe-commands.ts: isSafeReadOnlyCommand`
- Permission auto-approve gate: `cli-client/src/agent/permissions.ts` (consults `isSafeReadOnlyCommand` before `ask`)
- System-prompt section: `server/src/providers/prompt/sections/investigation.ts` (platform-aware)
- Brief field: `server/src/reasoning/reasoning-schema.ts: investigationPlan` on implement + bug envelopes
- Brief renderer: `server/src/providers/prompt/sections/reasoning-brief.ts` (`═══ INVESTIGATE FIRST ═══` block)
- Repair: `server/src/reasoning/repair.ts` defaults `investigationPlan` to `[]`
- Divergence heuristic: `server/src/services/divergence-detector.ts: no_investigation_before_write`
- Budget policy: `server/src/services/free-tier-policy.ts: getInvestigationBudget`
- Budget reminder injection: `server/src/handlers/tool-result.ts: maybeInjectInvestigationBudgetReminder`
- Telemetry: `cli-client/src/agent/usage-log.ts: RunSummary.investigationCommandsCount`
- Flags: `quality.investigation_budget_reminder_enabled`, `awareness.no_investigation_heuristic_enabled`, `reasoning.investigation_plan_enabled`

## Reasoner backends (model-aware)

- **Source:** plan `applied/2026-05-07-model-lock-and-portable-reasoning.md` (Stages D + E)

Before Stage D, every Phase 5/10/11/15/16 reasoning call hit Gemini Flash directly. After Stage D, the reasoner is pluggable: each run's main model maps to a same-vendor reasoner when available, falling back through other configured backends only as a last resort. The selection is pure-deterministic (no LLM judgement), and the resolved backend is constant for the run.

```
┌──────────────────────────────────────────────────────────────────────────┐
│  runReasoning(payload)                                                    │
│       │                                                                   │
│       ▼                                                                   │
│  pickReasonerBackend({ model, flagOverride, env })                       │
│       │   walks (1) explicit flag override                                │
│       │         (2) main-model family                                     │
│       │         (3) which API keys are configured                         │
│       │                                                                   │
│       │  null → no backend available → legacy single-turn fallback        │
│       │                                                                   │
│       ▼                                                                   │
│   ┌───────────┐    ┌──────────────┐    ┌──────────────────┐               │
│   │ gemini    │    │ anthropic    │    │ openrouter       │               │
│   │ 2.5-flash │    │ haiku-4-5    │    │ gemini-2.0-flash │               │
│   │ (SDK)     │    │ (/v1/messages)│   │ -exp:free (REST) │               │
│   └─────┬─────┘    └──────┬───────┘    └────────┬─────────┘               │
│         │                 │                     │                         │
│         └─────────────────┴─────────────────────┘                         │
│                           │  raw JSON envelope string                     │
│                           ▼                                               │
│             callReasoner returns to runReasoning →                        │
│             parse + repair + cache + return brief                         │
└──────────────────────────────────────────────────────────────────────────┘
```

### Selection matrix (auto mode)

| Main model family                            | Preference (first available key wins)    |
| -------------------------------------------- | ----------------------------------------- |
| `claude-*`                                   | anthropic → gemini → openrouter           |
| `gemini-*` / `swe`                           | gemini → openrouter → anthropic           |
| `openrouter-auto` / `llama-*` / `mistral-*` / `gemini-flash-or` | gemini → openrouter → anthropic |
| unknown / null                               | gemini → anthropic → openrouter           |

Rationale lives in `decisions.md: ## Reasoner backend follows the main model, not the user's preference flag`.

### Telemetry (Stage E)

- Server: `task-reasoner.ts` maintains `reasonerBackendByRun: Map<string, ReasonerBackend>`, populated on the first `callReasoner` per run when `payload.runId` is provided.
- `getReasonerBackendForRun(runId)` is read by `handlers/user-message.ts` + `handlers/tool-result.ts`; the value lands on `ClientResponse.reasonerBackend`.
- CLI: `cli-client/src/agent/agent.ts` captures `reasonerBackend` from the first response that carries it; reasonable invariant since the value is run-constant.
- Persisted: `cli-client/src/agent/usage-log.ts: RunSummary.reasonerBackend` → `usage.jsonl` per-run JSONL entry, null sentinel when no brief was produced.

### Cross-backend fallback is OUT OF SCOPE (deliberate)

If Anthropic Haiku rate-limits mid-run, sysflow does NOT silently fall over to Gemini Flash. The existing `callReasonerWithTimeout` wrapper catches transient hiccups; persistent failures surface so operators know their backend is degraded. The dispatcher's `null` return (no API key for the chosen backend) is the only place the reasoner gracefully degrades — and there the degrade is to legacy non-reasoning mode, not a different reasoner.

Why: cross-backend fallback was rejected by the model-lock plan because it re-introduces the *exact* symptom Stage A was designed to fix — silent swap to a different provider. The same logic applies to reasoners as to main models. If `usage.jsonl` shows Haiku rate-limiting often enough to be a real pain, a future plan can revisit; until then, the unobservable swap is worse than the observable degradation.

### Key files (one source of truth per concern)

- Selection: `server/src/services/free-tier-policy.ts: pickReasonerBackend` (+ `ReasonerBackend` type)
- Dispatcher: `server/src/reasoning/backends/index.ts: callReasonerBackend`
- Backend modules: `server/src/reasoning/backends/{gemini,anthropic,openrouter}-backend.ts`
- Per-run telemetry: `server/src/reasoning/task-reasoner.ts: reasonerBackendByRun` + `getReasonerBackendForRun` + `clearReasonerBackendForRun`
- Flag: `server/src/services/flags.ts: reasoning.backend` (default `"auto"`)
- Client surface: `server/src/types.ts: ClientResponse.reasonerBackend`
- CLI summary: `cli-client/src/agent/usage-log.ts: RunSummary.reasonerBackend`

## Task display selectivity (Phase 19)

- **Source:** plan `applied/2026-05-07-phase-19-task-display-selectivity.md`

The visible task box at the top of `<AgentStream>` is conditional on the run's classified intent. Only `implement` runs render the multi-step plan; simple Q&A, summary, and bug-fix pipelines surface via tool cards + `<ReasoningPeek>` alone.

```
┌────────────────────────────────────────────────────────────────────┐
│  user_message                                                       │
│       │                                                              │
│       ▼                                                              │
│  server: classifyIntent(body.content) → "simple" / "summary" /      │
│          "bug" / "implement". Attached to ClientResponse.runIntent.  │
│       │                                                              │
│       ▼                                                              │
│  cli runAgent: captures initial response.runIntent.                  │
│                Emits `intent_classified` event so the reducer holds  │
│                runIntent for the lifetime of the run.                │
│                Reads `taskDisplaySelective` from sysbase (default    │
│                true). Threads both through NeedsToolCtx.             │
│       │                                                              │
│       ▼                                                              │
│  cli handleNeedsTool: taskDisplayGated =                            │
│      taskDisplaySelective && runIntent !== "implement"               │
│                                                                      │
│      if (response.task && !taskDisplayGated):                        │
│          ┌─ renderPipelineBox (legacy console) ─┐                    │
│          │  printStepTransition on transitions  │  ← only when       │
│          │  taskSteps populates ctx for         │     runIntent ===  │
│          │  renderCompletion's final summary    │     "implement"    │
│          └──────────────────────────────────────┘                    │
│                                                                      │
│      else (non-implement OR flag-off):                              │
│          ┌─ tool cards stream                   ─┐                   │
│          │  ReasoningPeek shows brief content   │   ← lean surface   │
│          │  Header gets · thinking through it · │                    │
│          │  for non-implement + chunk_plan      │                    │
│          └──────────────────────────────────────┘                    │
└────────────────────────────────────────────────────────────────────┘
```

### Sticky classification, not reactive

The intent is classified once from the user's prompt and held for the whole run. Complexity may upgrade mid-run (chunked-loop may grow the buildPlan) but the visible-task gate doesn't flip — see `decisions.md: ## Task box gates on intent classification, not on prior-render heuristics` for the rejected alternatives.

### Composition with Phase 18 (when it lands)

Phase 18 (still draft) gates `taskPlan` EMISSION on the server side. Phase 19 owns the cli RENDER side. Both layers can ship independently; together they form defense-in-depth. Phase 19 doesn't require Phase 18 — even if a stray taskPlan slips through from a free-tier model that ignored the prompt directive, the cli's frontend gate hides it.

### Internal-task indicator

When `chunk_plan` has fired (internal work IS happening) AND `runIntent !== "implement"` (the box is gated off), the Header surfaces a tiny muted `· thinking through it` cell. Lets the user see activity without the multi-step plan UI claiming the conversation.

### Key files (one source of truth per concern)

- Server emission: `server/src/handlers/user-message.ts` + `server/src/handlers/tool-result.ts` → `clientResp.runIntent = classifyIntent(content)`
- Client surface: `server/src/types.ts: ClientResponse.runIntent`
- CLI event: `cli-client/src/agent/events.ts: intent_classified`
- CLI reducer slot: `cli-client/src/ui/hooks/useAgentEvents.ts: AgentEventState.runIntent`
- CLI capture + gate: `cli-client/src/agent/agent.ts: runIntent + taskDisplaySelective + taskDisplayGated`
- Header indicator: `cli-client/src/ui/components/Header.tsx: showInternalTaskIndicator`
- Setting: `cli-client/src/lib/sysbase.ts: getTaskDisplaySelective` (default `true`)

## LLM-driven intent classification

- **Source:** plan `applied/2026-05-15-llm-iterative-intent-classification.md`

Intent classification (`simple` / `bug` / `summary` / `implement`) decides which preflight pipeline runs + drives Phase 18's taskPlan-emission gate + Phase 19's cli render gate. Before this plan it was a brittle synchronous regex that hit compound-noun landmines (e.g. *"error handling"* in a build prompt's feature list tripped `\berror\b` → bug pipeline). After this plan it's an LLM iterative paragraph chain with self-directing depth, with the regex as fast-path + fallback.

```
┌──────────────────────────────────────────────────────────────────────┐
│  user_message.ts (handler entry)                                      │
│      ↓                                                                │
│  classifyIntentSmart(args)  (intent-classifier.ts)                    │
│      ↓                                                                │
│  ┌─ 1. CACHE HIT ─┐                                                   │
│  │  getIntentForRun(runId) ≠ null  → return cached. No regex, no LLM. │
│  └────────────────┘                                                   │
│      ↓ (miss)                                                         │
│  ┌─ 2. REGEX FAST-PATH ─┐                                             │
│  │  classifyIntentByRegex → if SIMPLE_PATTERNS match → cache + commit │
│  │  (continuation phrases, bare `ls`, `/list`, etc.)                  │
│  │  Flag: `intent_classification_fast_path_regex_enabled` (default on)│
│  └──────────────────────┘                                             │
│      ↓ (non-simple)                                                   │
│  ┌─ 3. LLM CHAIN ─┐                                                   │
│  │  classifyIntentByChain (intent-classification-pipeline.ts)         │
│  │  Up to 6 iterations (cap from                                       │
│  │    `intent_classification_max_iterations` flag).                   │
│  │  Each iteration emits ONE senior-engineer paragraph + `done` flag. │
│  │  LLM owns the depth — commits with `done: true` when ready;        │
│  │  iterates with `done: false` when another pass would help;         │
│  │  can `supersedes: N` to revise a prior paragraph instead of        │
│  │  stacking contradictions.                                          │
│  │  Returns { hypothesis, confidence, paragraphs[], iterations,       │
│  │    committedVia: "done_flag" | "step_cap" }                        │
│  └────────────────┘                                                   │
│      ↓ (chain returned null OR flag off)                             │
│  ┌─ 4. REGEX FALLBACK ─┐                                              │
│  │  Use the regex's result. source: "regex_fallback". Same shape as   │
│  │  pre-plan behaviour — the safety net.                              │
│  └────────────────────┘                                               │
│      ↓ (cache the resolved hint regardless of source)                 │
│  setIntentForRun(runId, hint)                                         │
│      ↓                                                                │
│  Return { hint, source, paragraphs? }                                 │
└──────────────────────────────────────────────────────────────────────┘
```

### The senior-engineer rubric

The pipeline's system prompt frames each iteration as one mid-to-long paragraph in flowing prose (not a form). Six points:

1. **Restate** the user's exact phrasing
2. **Why this hypothesis vs alternatives**
3. **Trade-offs** — cost of being wrong each direction
4. **End-to-end check** — what pipeline runs, would output be right?
5. **Double-check** — re-read opening verb + compound nouns
6. **Decide** — commit (`done: true`) OR end paragraph with the question another pass would answer

Compound-noun trap is called out explicitly: *"build a service with error handling"* → implement; *"the auth service throws an error on login"* → bug.

### Per-run cache caps total Flash spend to ~1 call per run

- `user-message.ts` calls `classifyIntentSmart` on the first turn → cache populates.
- `tool-result.ts` uses `getCachedIntentOrRegex(runId, content)` → cache hits on every subsequent turn.
- `task-reasoner.ts/pickPipeline` reads from cache too (keeping `pickPipeline` sync).
- Cleared on terminal exit alongside the other per-run state stores.

Telemetry: `RunSummary.intentClassificationSource` (`cache` / `regex_simple` / `chain` / `regex_fallback`) lands in `~/.sysflow/usage.jsonl` so operators can see distribution per run.

### `<ReasoningPeek>` surfaces the chain's paragraphs

When `intentClassificationSource === "chain"`, the server attaches `intentClassificationParagraphs[]` to the initial `ClientResponse`. `agent.ts` emits a `reasoning_brief` event with `kind: "intent_classification"` and `briefData.reasoningChain` carrying the paragraphs. The peek's plain-prose render path (PR #83) picks them up automatically — no new render code.

User sees:
```
✦ Reasoning(intent_classification)
  → The user asked to "build a Node.js Express PostgreSQL backend ..."
    starting with a strong build verb. "error handling" is a FEATURE
    in the build request, not a symptom — clear implement intent.
  → Committing with HIGH confidence; no alternative reading is plausible.
```

### Key files

- Pipeline prompt: `server/src/reasoning/pipelines/intent-classification-pipeline.ts`
- `PipelineKind` registry: `server/src/reasoning/pipelines/index.ts`
- Schema + orchestrator + smart wrapper: `server/src/reasoning/intent-classifier.ts`
- Per-run cache: `server/src/services/intent-cache.ts`
- Client surface: `server/src/types.ts: ClientResponse.intentClassificationSource + intentClassificationParagraphs`
- Server population: `server/src/handlers/user-message.ts` (first turn) + sync cache reads in `tool-result.ts` / `task-reasoner.ts/pickPipeline`
- CLI capture: `cli-client/src/agent/agent.ts: intentClassificationSource` + reasoning_brief emit
- CLI telemetry: `cli-client/src/agent/usage-log.ts: RunSummary.intentClassificationSource`
- Flags:
  - `reasoning.intent_classification_via_llm_enabled` (default `true`) — kill switch
  - `reasoning.intent_classification_max_iterations` (default `6`) — depth cap
  - `reasoning.intent_classification_fast_path_regex_enabled` (default `true`) — force-all-through-LLM toggle

## Forced error reasoning + recovery

- **Source:** plan `applied/2026-05-15-forced-error-reasoning-and-recovery.md`

Four overlapping nets force the agent to stop, reason about, and address every tool error before proceeding. The user-reported failure mode is **the agent skims past errors and moves on without engaging** — Phase 5's on-error bug brief was easy to ignore in the prompt stream. The fix is system-level: chain → inject → reject → memory.

```
┌──────────────────────────────────────────────────────────────────┐
│  tool result with error  (incomingErrors.length > 0)             │
│       │                                                          │
│       ▼                                                          │
│  recallErrorPatterns        (Stage 5)                            │
│       │   match on (platform + signature) from .sysflow-memory.md│
│       │   matches → priorRecall string                           │
│       ▼                                                          │
│  runErrorReasoningChain     (Stage 1+2)                          │
│       │   iterative paragraphs, 1-4 calls, self-directing depth  │
│       │   commits with { rootCause, alternatives, recommended,   │
│       │                  paragraphs[], confidence }              │
│       │   on null → falls back to Phase 5 on_error bug pipeline  │
│       ▼                                                          │
│  ═══ ERROR — REASON THROUGH THIS ═══   (Stage 3, inject)         │
│       │   block rendered at END of next tool-result body         │
│       │   model MUST acknowledge + pick a recovery               │
│       ▼                                                          │
│  callModelAdapter                                                │
│       │                                                          │
│       ▼                                                          │
│  validateErrorAcknowledgement  (Stage 4, hard veto)              │
│       │   if response did not acknowledge AND did not pivot      │
│       │   → inject reject prompt + re-call (up to 3 rejections)  │
│       │   hard-fail on same-(tool, primaryArg) retry             │
│       ▼                                                          │
│  next tool result (no error)                                     │
│       │                                                          │
│       ▼                                                          │
│  recordErrorPattern         (Stage 5, learning)                  │
│           failedCommand → workingCommand persisted               │
│           next similar error short-circuits via recall above     │
└──────────────────────────────────────────────────────────────────┘
```

The four nets are **additive, not alternative**: chain produces the reasoning, inject forces the agent to read it, reject veto stops it from ignoring it, memory makes the recovery improve across runs. Each stage has its own kill switch flag (`quality.force_error_reasoning_enabled`, `quality.error_acknowledgement_rejection_enabled`, `memory.error_pattern_recall_enabled`).

**Key boundaries:**

- Chain runs on the FIRST error (Phase 11 awareness handles sustained drift after the cap).
- Chain returning `null` is signal to fall back to the existing Phase 5 bug pipeline — never silent.
- Same `(tool, primaryArg)` retry is the canonical broken behaviour the validator catches.
- Recording is conservative — only `run_command` recoveries are mined for v1 (other tools' recoveries are too heterogeneous).

**Files & flags:**

- Pipeline + schema + orchestrator: `server/src/reasoning/error-reasoner.ts` + `pipelines/error-reasoning-pipeline.ts`
- Inject block renderer: `server/src/services/error-reason-block.ts`
- Server-side validator + reject builder: `server/src/services/error-acknowledgement-guard.ts`
- Memory: `server/src/memory-store/error-pattern.ts` (recorder + recall + format/parse + reasoner-prose render)
- Wiring: `server/src/handlers/tool-result.ts` (recall + chain + inject + reject loop + recovery recorder, in this order)
- Provider injection point: `server/src/providers/base-provider.ts: buildToolResultMessage` (block lands LAST in the tool-result body)
- Client surface: `server/src/types.ts: ClientResponse.errorReasoningParagraphs + errorReasoningSource + errorAckRejectionCount`
- CLI capture + telemetry: `cli-client/src/agent/agent.ts` + `usage-log.ts: RunSummary.errorReasoningSource / errorReasoningEvents / errorAcknowledgementRejections`
- Flags:
  - `quality.force_error_reasoning_enabled` (default `true`) — chain + inject kill switch
  - `reasoning.error_reasoning_max_iterations` (default `4`) — chain depth cap
  - `quality.error_acknowledgement_rejection_enabled` (default `true`) — Stage 4 reject loop kill switch
  - `memory.error_pattern_recall_enabled` (default `true`) — Stage 5 recall + recorder kill switch

## Project-init reasoning

- **Source:** plan `applied/2026-05-15-agent-runtime-fixes-and-project-init-reasoning.md`

Every implement-class run starts with a project-init iterative reasoner that classifies the working directory and emits guidance for the agent's FIRST move. Fires **before** the preflight reasoner — the rest of the run reads against the classified repo shape. Cures the user-reported behaviour where the agent demanded `tsconfig.json` in an empty directory and hard-stopped on a 0-hit web search.

```
┌──────────────────────────────────────────────────────────────────┐
│  user_message                                                    │
│       │                                                          │
│       ▼                                                          │
│  ingestDirectoryTree           (server context-manager)          │
│       │                                                          │
│       ▼                                                          │
│  runProjectInitChain           (1-3 Flash iterations)            │
│       │   classifies → { repoState, fileCount, keyMarkers,       │
│       │                  investigationPlan[],                    │
│       │                  skipConfigVerificationFor[],            │
│       │                  confidence }                            │
│       │   on null → falls back to today's behaviour              │
│       ▼                                                          │
│  setConfigSkipList             (when HIGH/MEDIUM + empty/small)  │
│       │   action-planner's config-search hijack now skips        │
│       │   the listed files (fresh scaffold = no verification)    │
│       ▼                                                          │
│  ═══ PROJECT STATE ═══         (prompt section, priority 104)    │
│       │   repoState-specific guidance:                           │
│       │     empty           → do NOT web-search authored configs │
│       │     small           → read README + obvious config       │
│       │     existing-small  → READ THE MANIFEST + relevant src   │
│       │     existing-large  → MANDATORY: investigate before write│
│       ▼                                                          │
│  runReasoning (preflight)      (reads against PROJECT STATE)     │
└──────────────────────────────────────────────────────────────────┘
```

**Classification table:**

| repoState | criteria | first-move expectation |
|---|---|---|
| `empty` | 0-1 entries OR only `.git/` | scaffold from scratch, no investigation reads of non-existent files |
| `small` | 2-15 entries, no package manifest | read README + obvious config first |
| `existing-small` | has manifest + < 50 source files | read manifest + relevant source before edits |
| `existing-large` | has manifest + ≥ 50 source files OR monorepo | mandatory investigation; greenfield prompt = confirm via `_user_response` |

**Files & flags:**

- Pipeline + schema + orchestrator: `server/src/reasoning/project-init-reasoner.ts` + `pipelines/project-init-pipeline.ts`
- Skip list machinery: `server/src/services/setup-intelligence.ts` (`setConfigSkipList` / `isConfigSkipped` / `detectConfigFile(path, runId)`)
- Wiring: `server/src/handlers/user-message.ts` (fires AFTER `ingestDirectoryTree`, BEFORE preflight)
- Prompt section: `server/src/providers/prompt/sections/project-state.ts`
- Cli surface: `ClientResponse.projectInitParagraphs / projectInitRepoState / projectInitConfidence`
- Telemetry: `RunSummary.projectInitRepoState / projectInitConfidence`
- Flags:
  - `quality.project_init_reasoning_enabled` (default `true`) — kill switch
  - `reasoning.project_init_max_iterations` (default `3`) — chain depth cap

**Composes with:**

- Stage 2 (web search gating + 0-hit recovery): the project-init brief tells the agent which configs are being authored; the web_search tool description repeats the rule; the action-planner skip list mechanically enforces it. Three layers of pressure.
- Stage 4 (per-turn directory refresh): when the agent later deletes files, the refreshed tree surfaces stale references via the `═══ DIRECTORY STATE CHANGED ═══` inject — the agent's mental model of the project shape stays current across turns.

## Reasoning-chain provider parity (peek refresh on all backends)

- **Source:** plan `applied/2026-05-16-reasoning-chain-provider-parity.md`

Project-init reasoning + per-turn reasoning briefs only reach the cli's `<ReasoningPeek>` if the model's per-turn response actually carries `reasoningChain[]`. Provider-parity reality: not all models emit the structured field consistently. The cli's live peek would stay stuck on the project-init brief from minute 1, even though the agent kept reasoning per-turn (visible inline as `│ <text>` from `response.reasoning`).

The plan layered four mechanical fixes so the peek refreshes on EVERY turn regardless of which provider serves the run:

```
┌──────────────────────────────────────────────────────────────────┐
│  model emits response                                            │
│       │                                                          │
│       ▼                                                          │
│  parseJsonResponse (base-provider)                               │
│       │   extracts reasoningChain[] from JSON                    │
│       │   Stage 3: weak-completion + tool-gate overrides         │
│       │     now preserve reasoningChain through synthesis        │
│       ▼                                                          │
│  validateCompletionResponse                                      │
│       │   may swap weak-completed → needs_tool                   │
│       │   (chain carried through)                                │
│       ▼                                                          │
│  mapNormalizedResponseToClient (normalize.ts)                    │
│       │                                                          │
│       ▼                                                          │
│  resolvePerTurnReasoningChain                                    │
│       │   if array non-empty → use verbatim ("structured")       │
│       │   if singular reasoning present → synthesise one-element │
│       │     chain from it ("synthesised")                        │
│       │   else → undefined                                       │
│       ▼                                                          │
│  ClientResponse.perTurnReasoningChain + perTurnReasoningSource   │
│       │                                                          │
│       ▼                                                          │
│  cli agent.ts                                                    │
│       │   emit `reasoning_brief` event kind="per_turn"           │
│       │   accumulate RunSummary counters                         │
│       ▼                                                          │
│  <ReasoningPeek> refreshes with new brief.key                    │
└──────────────────────────────────────────────────────────────────┘
```

**Key composition:** Stage 2's MANDATORY prompt directive shifts the distribution toward structured emission; Stage 1's synthesis catches the residual; Stage 3 preserves the chain through server-side overrides. Telemetry on `RunSummary.reasoningChainEmittedTurns` vs `reasoningChainSynthesisedTurns` shows the structured-vs-fallback ratio over time.

**Files:**

- Normaliser: `server/src/providers/normalize.ts` (`resolvePerTurnReasoningChain` + `classifyPerTurnReasoningSource`)
- Prompt directive: `server/src/providers/prompt/sections/tools.ts` (MANDATORY block)
- Overrides preservation: `server/src/providers/base-provider.ts` (weak-completion + tool-gate spread `reasoningChain`)
- Client surface: `server/src/types.ts: ClientResponse.perTurnReasoningChain + perTurnReasoningSource`
- CLI capture + telemetry: `cli-client/src/agent/agent.ts` + `usage-log.ts: RunSummary.reasoningChainEmittedTurns / reasoningChainSynthesisedTurns`
