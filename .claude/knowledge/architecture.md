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
