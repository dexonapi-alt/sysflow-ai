# Current Project Status

> Last updated: 2026-05-02

## Recent Work

**Phase 2 foundation pass** (`.claude/plans/applied/2026-05-02-phase-2-foundation.md`):

- **Tool-error classifier**: `services/tool-error-classifier.ts` returns one of validation | permission | file_not_found | file_too_large | timeout | command_failed | command_not_found | network | auth | unknown plus a tool-specific recovery hint that's appended to the AI's tool result. Replaces the regex-only legacy hint table for any error the classifier recognises.
- **Project memory file**: `services/project-memory.ts` discovers `.sysflow.md` (preferred) or `CLAUDE.md` (fallback) in cwd, parent dir, and `~/.sysflow/MEMORY.md`. New `prompt/sections/project-memory.ts` injects discovered content into the prompt's dynamic half. Memoised by mtime, hard-capped at 50k chars combined, skips files matching common secret patterns. `cwd` is now plumbed through `ProviderPayload`.
- **Real autocompact**: `compactConversationSummary()` asks the model to produce a structured markdown summary (original task / files touched / decisions / current state / unresolved) and replaces chat history with a single summary turn. Singleton `AutocompactCircuitBreaker` opens after 3 consecutive failures per run. Recursion guard prevents summary-of-summary calls.
- **Max-output-token recovery**: `BaseProvider.nextMaxOutputAction(runId)` returns `escalate` | `continue` | `fail` per attempt (max 3). Gemini provider's new `sendWithMaxOutputRecovery` wraps `chat.sendMessage`; on `finishReason === 'MAX_TOKENS'` it issues a continuation prompt and concatenates partial text until the model finishes or the limit hits.
- **Tool-result archival**: `store/tool-result-persistence.ts` writes results larger than 10 KiB to `<sysbasePath>/tool-results/<runId>/<toolId>.json` as full pre-budget payloads. Best-effort, never throws. Budget-clamped result gains `_persistedPath` + `_persistedSize`.
- **Concurrency partitioning + sibling abort**: `cli-client/src/agent/tool-meta.ts` is the single source of truth for per-tool flags (`isConcurrencySafe`, `isReadOnly`, `abortsSiblingsOnError`). `executor.ts` uses `partitionToolCalls()` and short-circuits serial siblings with `aborted_by_sibling: true` when a `run_command` fails. CLI preview renders `↯ aborted` for those.

**Phase 1 reasoning + CLI UX pass** (`.claude/plans/applied/2026-05-02-phase-1-reasoning-and-cli-ux.md`):

- **Modular system prompt**: extracted the monolithic `SHARED_SYSTEM_PROMPT` into priority-sorted sections under `server/src/providers/prompt/sections/` (identity, system rules, tools, task guidelines, output efficiency, env info, model-specific) joined by an explicit `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` marker so future provider-side caching can split on it.
- **Context budget**: new `server/src/services/context-budget.ts` exposes `estimateTokens`, per-tool `TOOL_RESULT_MAX_CHARS`, `applyToolResultBudget`, and `microcompactGeminiHistory`. Wired into both handlers + Gemini chat-history rebuild.
- **Pre-API token guard**: `user-message.ts` and `tool-result.ts` reject oversized payloads with `errorCode: 'prompt_too_long'` before calling the provider.
- **Schema fixes**: Gemini `RESPONSE_SCHEMA` now includes `waiting_for_user` in `kind` and a `taskPlan` property.
- **Malformed-response cap**: `parseJsonResponse` tracks per-run failures and returns `failed` after 2 in a row instead of silently coercing to `list_directory` forever.
- **CLI refactor**: `cli-client/src/agent/agent.ts` (was 1160 lines of mixed concerns) now imports rendering primitives from `cli/render.ts`, diff-Tab handling from `cli/diff-preview.ts`, tool-result previews from `cli/tool-result-preview.ts`, and dispatches transitions through `agent/state-machine.ts` with retry budgets in `agent/retry.ts`.
- **Tool-result preview**: each tool now prints a short preview line (first 3 lines for reads, exit code + last stdout line for commands, match count for searches) instead of dropping straight back into the spinner.

Earlier completed work:

- Converted all CLI modules to TypeScript (agent, commands, CLI, lib)
- Fixed TypeScript errors in server tool-result and billing routes
- Updated README to reflect TypeScript migration

## What's Done

- Full server with Fastify 5.x, routes, handlers, providers, stores
- PostgreSQL schema with 9 migrations (auto-run on startup)
- Multi-provider AI system (Gemini, OpenRouter functional; Claude Sonnet/Opus **mocked**)
- SWE mock provider for demo/testing (deterministic 20+ step auth system build)
- CLI client with agent loop, 11 tools, interactive UI
- Authentication (register, login, JWT with 30-day expiry)
- Billing integration (Stripe checkout, webhooks, SSE stream, 4 plans)
- Chat session management with project scoping
- Context auto-save system (memories on success, fixes on failure)
- Fix files auto-written to `sysbase/fixes/` on failed tasks
- File mention syntax (`@filepath`) in prompts
- TypeScript migration complete (strict mode, ES2022)

## What's NOT Done / Needs Work

- **Claude Sonnet provider**: Returns mock responses (TODO in code)
- **Claude Opus provider**: Returns mock responses (TODO in code)
- **docs/ still reference .js files**: docs/server.md and docs/cli-client.md show `.js` extensions (pre-migration)
- **No refresh token mechanism**: JWT expires after 30 days, no renewal
- **Default JWT_SECRET is weak**: `"sysflow-secret-change-me"` in production default

## Branch State

- **Main branch**: clean, all committed
- Latest commit: `ecd647f` — docs: update README for TypeScript migration

## Known Architecture Notes

- In-memory stores (runs, tasks, tool-results, memory) **reset on server restart**
- Only `openrouter-auto` and `gemini-flash` are visible in CLI model picker
- Tool execution has a 30-second timeout on `run_command`
- Server has a 5-minute per-request timeout
- `edit_file` tool does full file replacement, not diff-based editing
- Long-running commands (npm start, etc.) are detected and skipped by CLI
- Free plan tracks prompts via `free_prompts_today`/`free_prompts_reset_at` on users table
- Paid plans use credit system (NUMERIC cents in DB)
- Session history limited to 20 entries in AI prompts, 50 in chat view
- Orphaned sessions (from interrupted runs) are auto-saved as "interrupted"
