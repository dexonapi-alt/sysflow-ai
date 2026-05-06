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
