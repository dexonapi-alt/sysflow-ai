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
