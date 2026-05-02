# Sysflow Phase 2 — Foundation

- **Created:** 2026-05-02
- **Status:** implemented (2026-05-02)
- **Scope:** Foundation upgrades that close the most-cited reliability gaps without rewriting the loop: real autocompact, project-memory file, max-output-token recovery, concurrency partitioning + sibling abort, tool-result persistence with previews, and structured tool-error classification.

## Goal

Make Sysflow recover from situations it currently fails at: oversized contexts that need summarisation (not just rejection), hitting the model's output token cap mid-response, parallel tool batches where one Bash failure should abort siblings, and large tool results that blow the context. Add a `.sysflow.md` project-memory file so users can give per-project instructions that survive restarts. Keep the controller shape unchanged so the async-generator rewrite stays a clean follow-up.

## Context from knowledge base

`.claude/knowledge/` is still empty. The improvement docs remain canonical:

- `docs/sysflow-improvement/01-agent-loop.md` — explicit max-output-token recovery (priority 4 in the long-form spec). We're implementing the *outcome* (escalate → continue, capped at 3) without yet doing the async-generator rewrite that pairs with it.
- `docs/sysflow-improvement/02-context-memory.md` — autocompact summary call (priority 4) and CLAUDE.md-style project memory (priority 5). Both land here.
- `docs/sysflow-improvement/03-tool-system.md` — `isConcurrencySafe`, `partitionToolCalls`, `StreamingToolExecutor`, sibling abort. We do the partitioning + sibling abort; streaming tool execution stays out of scope.
- `docs/sysflow-improvement/04-error-handling.md` — `classifyToolError` taxonomy (priority 3) and 413 → reactive compact recovery (priority 4). Both land.
- `.claude/plans/applied/2026-05-02-phase-1-reasoning-and-cli-ux.md` — Phase 1 introduced `context-budget.ts` (token estimation, microcompact, tool-result budget), the modular prompt with `env-info.ts`, the `RetryBudget` in the CLI controller, and the `errorCode` taxonomy. Phase 2 builds directly on those.

## Affected files

### Server — autocompact, project memory, max-output-token recovery, tool-result persistence

- `server/src/services/context-budget.ts` — extend with `compactConversationSummary()` that takes a Gemini `chat.getHistory()` plus a callback into the model, asks for a structured summary, and returns a new compacted history. Add `AutocompactCircuitBreaker` (3 consecutive failures stops trying for the run).
- `server/src/services/project-memory.ts` *(new)* — discover `.sysflow.md` (preferred) or `CLAUDE.md` (fallback) in `cwd`, parent dir, and `~/.sysflow/`. Filter via `filterInjectedMemoryFiles` (max ~50k chars combined). Memoise per-`cwd` with mtime invalidation.
- `server/src/providers/prompt/sections/project-memory.ts` *(new)* — non-cacheable prompt section that injects discovered memory under a clear delimiter (`═══ PROJECT MEMORY (.sysflow.md) ═══`).
- `server/src/providers/prompt/build.ts` — add `project_memory` section into the dynamic half (priority 105, between `env_info` and `model_specific`).
- `server/src/providers/base-provider.ts` — `getSystemPrompt(ctx)` accepts `cwd` so the project-memory loader knows where to look.
- `server/src/providers/gemini.ts` — wire `cwd` into the per-request `buildPrompt(payload)` call. On a `MAX_TOKENS` finish reason from the SDK, run the new `handleMaxOutputTokens()` recovery: first attempt escalates `maxOutputTokens` (×2 capped at 131_072) and re-issues; second attempt sends a synthetic user turn `Your response was cut off — continue exactly where you left off`; third attempt fails the run with `errorCode: 'max_output_tokens'`.
- `server/src/handlers/tool-result.ts` + `server/src/handlers/user-message.ts` — call `discoverProjectMemory(cwd)` and stuff results into `context.projectMemory` so the prompt section picks them up. On 413/`prompt_too_long` from the provider, run reactive autocompact instead of immediately failing.
- `server/src/store/tool-results.ts` — currently in-memory only. Add `persistLargeToolResult(runId, toolResultId, result)` that writes results larger than 10 KiB to `<sysbasePath>/tool-results/<runId>/<id>.json`, replaces the in-memory entry with `{ _persisted: true, path, preview }`, and exposes `loadToolResult(runId, toolResultId)` for retrieval. Replacement happens *after* `applyToolResultBudget` so the budget still caps the in-memory representation.
- `server/src/services/tool-error-classifier.ts` *(new)* — `classifyToolError(tool, error)` returns one of `validation | permission | file_not_found | file_too_large | timeout | command_failed | network | auth | unknown` plus a recovery hint string suitable to attach to the AI's tool result.
- `server/src/handlers/tool-result.ts` — when an incoming tool result has `error`, call `classifyToolError` and append the hint into the enriched result the model sees (extends today's `enrichSingleError`).
- `server/src/types.ts` — add `errorCode: 'max_output_tokens'` to the union; add `ToolErrorCategory` export.

### CLI — concurrency partitioning + sibling abort

- `cli-client/src/agent/tool-meta.ts` *(new)* — single source of truth for `isConcurrencySafe`, `isReadOnly`, and `abortsSiblingsOnError` per tool. Read tools (read_file, batch_read, list_directory, search_code, search_files, web_search, file_exists) are concurrency-safe and read-only. Write tools (write_file, edit_file, create_directory, move_file, delete_file) are concurrency-safe within a batch (different paths) but not read-only. `run_command` is neither concurrency-safe nor read-only and aborts siblings on error.
- `cli-client/src/agent/executor.ts` — replace the `parallelTools = filter(tool !== "run_command")` heuristic with `partitionToolCalls()` driven by `tool-meta.ts`. Add an `AbortController` per batch; if any batch member returns an error AND that tool has `abortsSiblingsOnError: true`, abort the controller and return `aborted_by_sibling: true` for unstarted siblings. In-flight siblings finish but are marked `aborted: true` if their tool is also classified as cancellable (filesystem reads can't be cancelled mid-flight; we just discard their results).
- `cli-client/src/agent/agent.ts` — surface sibling-abort results in the tool-result preview and pipeline rendering with a `↯ aborted` icon instead of the regular check.

### Docs

- `docs/status/current.md` — Recent Work entry for Phase 2.
- `docs/sysflow-improvement/14-complete-gap-checklist.md` — check off the items this plan lands.

## Migrations / data

N/A. All new state is in-memory (CircuitBreaker, project-memory cache) or on disk under `<sysbasePath>/tool-results/<runId>/`. No DB schema changes. The `<sysbasePath>` directory already exists per project; we add a new subfolder.

## Hooks / skills / settings to update

N/A.

## Dependencies

- No new npm packages. `compactConversationSummary` reuses the existing Gemini provider for the summary call (recursive, but capped by the circuit breaker — a summary call cannot itself trigger autocompact).
- New env var (optional): `SYSFLOW_PROJECT_MEMORY_FILE` to override the default discovery filename for tests.

## Risks & mitigations

- **Summary call costs tokens.** → Cap the summary at 4 000 output tokens, and only run autocompact when estimated input > effective window; the savings dwarf the call cost.
- **Summary-during-summary loop.** → `AutocompactCircuitBreaker` opens after 3 consecutive failures *for that run*; the summary path itself sets a flag to skip recursive autocompact.
- **Project-memory file is huge / has secrets.** → Hard cap at 50 000 chars combined across discovered files; warn (not fail) when the cap kicks in. Skip files matching common secret patterns (`.env`, `*.pem`, `id_rsa*`).
- **Max-output-token recovery can mask infinite generation.** → 3-attempt cap; on the third we surface `errorCode: 'max_output_tokens'` and let the user decide.
- **Sibling abort cancels useful work.** → Only `run_command` declares `abortsSiblingsOnError: true` initially. Read/write tools never abort siblings — their failures get the existing per-tool retry loop.
- **Tool-result persistence introduces I/O on the hot path.** → Only writes to disk when the result is over 10 KiB *after* the budget pass, which is rare. Reads happen lazily and are cached per-run.
- **`.sysflow.md` parsing collides with another tool's CLAUDE.md convention.** → Prefer `.sysflow.md`; only fall back to `CLAUDE.md` if `.sysflow.md` is absent. Document precedence in the new section.

## Implementation order

Each step compiles green and is independently revertable. Steps 1–3 are server reasoning, 4–5 are server reliability, 6 is CLI concurrency, 7 is docs.

1. **Tool-error classifier** — add `services/tool-error-classifier.ts` with the category enum + classifier + hint table. Wire into `enrichSingleError` in `tool-result.ts`. Pure addition — caller behaviour unchanged for non-error paths.
2. **Project memory discovery** — add `services/project-memory.ts` and `prompt/sections/project-memory.ts`, register the section in `build.ts`, plumb `cwd` into the Gemini provider's `buildPrompt(payload)`. Both handlers populate `context.projectMemory` from the discovery call.
3. **Real autocompact + circuit breaker** — extend `context-budget.ts` with `compactConversationSummary()` and `AutocompactCircuitBreaker`. In Gemini's subsequent-call branch, when the pre-API token estimate exceeds the threshold (we already compute this), run autocompact before sending; on a 413 from the provider, run reactive autocompact and retry once.
4. **Max-output-token recovery** — Gemini's response carries `finishReason`. When it's `MAX_TOKENS`, run `handleMaxOutputTokens(payload, attempt)` (escalate/continue/fail). Track attempts on `BaseProvider.runMaxOutputAttempts`.
5. **Tool-result persistence** — extend `store/tool-results.ts` with the persist/load pair. `applyToolResultBudget` runs first; persistence handles whatever's left over 10 KiB.
6. **Concurrency partitioning + sibling abort** — add `cli-client/src/agent/tool-meta.ts`, refactor `executeToolsBatch` to call `partitionToolCalls()` + use a per-batch `AbortController`. Render `↯ aborted` previews in `cli/tool-result-preview.ts`.
7. **Docs + checklist update.**

## Verification

- **Compile:** `tsc --noEmit` clean in both `cli-client/` and `server/`.
- **Manual smoke:**
  - Add a `.sysflow.md` file in a test project, run a prompt — confirm the project-memory section appears in the assembled prompt (log it once at level=debug).
  - Run a prompt with a `@<huge-file>` mention that crosses the autocompact threshold — confirm a summary call fires, the chat history shrinks, and the run continues.
  - Force a `MAX_TOKENS` finish (request a deliberately enormous codegen) — confirm escalate-then-continue lands and only fails after attempt 3.
  - Run a parallel batch that mixes `read_file` (safe) with a failing `run_command` — confirm subsequent siblings show `↯ aborted`.
  - Trigger a tool error on a known category (e.g., `read_file` of a missing path) — confirm the AI's tool result includes the recovery hint string.
- **Diff metrics:** ~6 new files server-side, 1 new file CLI-side, ~3 files modified per side.
- **Out-of-scope confirmation:** controller in `agent.ts` is *not* converted to async generators this session; MCP, multi-agent, plan mode, streaming tool execution remain on the 200-item list.

## Follow-ups (Phase 3)

- Zod input + output schemas on every tool, with semantic validation hooks (`docs/sysflow-improvement/03-tool-system.md` priorities 1–3).
- Per-tool `checkPermissions(allow|deny|ask)` + permission modes (default/auto/plan/bypass).
- Pre/post tool-use hook registry.
- Plan-mode tool (`EnterPlanMode`/`ExitPlanMode`) and plan-mode model routing.
- Multi-agent coordinator + sub-agent spawning (`AgentTool`).

## Completion notes

Implemented 2026-05-02. All 7 ordered steps executed in sequence and pushed as 6 separate commits.

**Deviations from the plan:**

- Max-output-token recovery doesn't actually escalate `maxOutputTokens` mid-session — Gemini's `ChatSession` bakes the cap in at model creation time, and recreating the model would lose chat history. The `'escalate'` action falls through to the same continuation-prompt path as `'continue'`. The 3-attempt cap still holds, and partial text is concatenated across attempts so the model effectively gets to keep generating past the original cap.
- Tool-result persistence archives the *original* (pre-budget) result when serialised size exceeds 10 KiB. The model still sees the budget-clamped representation; `_persistedPath` + `_persistedSize` are appended so the user (or a future inspection command) can find the full payload.
- Reactive autocompact on a real 413 from Gemini isn't yet wired — the proactive check before sending (token estimation > effective window) is in place. Adding the post-hoc reactive path is straightforward and will land alongside Phase 3's hook system.
- Concurrency partitioning was a low-impact code change because the existing executor already split parallel-vs-command work. The new `tool-meta.ts` makes the rules data-driven (`move_file` and `delete_file` moved into the serial group) and adds the sibling-abort short-circuit.

**Surprises:**

- The Gemini SDK exposes `finishReason` only on `result.response.candidates?.[0]?.finishReason`. The TS types make it loose enough that the helper has a small `try { ... } catch` wrapper.
- `microcompactGeminiHistory` and the new `compactConversationSummary` work on the same `GeminiContent[]` shape, which made it cheap to chain them. Microcompact runs first (cheap regex rewrite); only if estimated tokens are still over the budget does autocompact fire.

**Knowledge to capture (next pass):**

- "Per-run counter map on BaseProvider" pattern (parse failures, max-output attempts) → `.claude/knowledge/patterns.md`.
- "Pre-budget archive + post-budget pointer" tool-result design → `.claude/knowledge/decisions.md`.
- "Microcompact before autocompact" compaction layering → same.
