# 14 — Complete Gap Checklist: Everything Claude Code Has That Sysflow AI Lacks

This is the exhaustive, line-by-line inventory. Every item is something Claude Code implements that Sysflow AI either completely lacks or implements at a fraction of the quality.

> **Legend:** `[x]` = implemented in this repo · `[~]` = partial / subset implemented · `[ ]` = not yet
> **2026-05-02 Phase 1–4 pass:** see `.claude/plans/applied/` for what landed in each pass:
> - Phase 1 (`2026-05-02-phase-1-reasoning-and-cli-ux.md`) — modular prompt, token guard, microcompact, agent.ts split.
> - Phase 2 (`2026-05-02-phase-2-foundation.md`) — real autocompact + circuit breaker, project memory, max-output recovery, sibling abort, tool-result archival, error classifier.
> - Phase 3 (`2026-05-02-phase-3-capabilities.md`) — Zod schemas + validation, permission system + modes + slash commands, hook registry + built-ins.
> - Phase 4 (`2026-05-02-phase-4-productionisation.md`) — feature flags, plan mode, daily-rotated audit log, usage telemetry, vitest suite (~30 cases).

---

## AGENT LOOP & ORCHESTRATION

- [ ] **Async generator loop** — `queryLoop` yields events, Sysflow uses request-response
- [ ] **StreamEvent system** — typed events for every lifecycle step
- [ ] **30+ step loop body** — compaction, token checks, streaming, tools, hooks, limits per iteration
- [~] **Explicit terminal reasons** — Phase 1 added `completed`, `failed`, `session_expired`, `usage_limit_exhausted`, `rate_limit_exhausted`, `max_consecutive_errors`, `prompt_too_long`, `malformed_response_exhausted`, `user_cancelled` in `cli-client/src/agent/state-machine.ts`. Still missing: `blocking_limit`, `aborted_streaming`, `aborted_tools`, `stop_hook_prevented`, `hook_stopped`, `max_turns`.
- [~] **Explicit continue reasons** — Phase 1 added `next_turn`, `tool_executed`, `tool_batch_executed`, `user_responded`, `completion_rejected`, `rate_limit_retry`, `usage_limit_retry`, `failure_retry`. Still missing: `collapse_drain_retry`, `reactive_compact_retry`, `max_output_tokens_escalate`, `max_output_tokens_recovery`, `stop_hook_blocking`, `token_budget_continuation`.
- [x] **Pre-API token guard** — `shouldBlockOnTokens()` in `server/src/services/context-budget.ts`, wired into both handlers; rejects with `errorCode: 'prompt_too_long'`.
- [ ] **Max turns limit** — configurable cap on loop iterations
- [ ] **Turn counter and tracking** — `turnCount`, `turnId`, `turnCounter` analytics
- [ ] **Query chain tracking** — `chainId`, depth tracking across compactions
- [ ] **Attachment queue** — `getCommandsByMaxPriority`, `getAttachmentMessages`, priority-based
- [ ] **Fallback model switch mid-stream** — `FallbackTriggeredError` handling with cleanup
- [~] **Max-output-token recovery** *(Phase 2)* — `BaseProvider.nextMaxOutputAction(runId)` (escalate → continue → fail, max 3). Gemini's `sendWithMaxOutputRecovery` concatenates partial text on `finishReason === 'MAX_TOKENS'`. Escalation doesn't really raise the token cap mid-session (Gemini SDK limitation); it falls through to continue.

## CONTEXT & MEMORY

- [x] **Autocompact** *(Phase 2)* — `compactConversationSummary()` asks the model for a structured summary (original task / files touched / decisions / current state / unresolved) and replaces history with one summary turn. Triggered before sending when estimated tokens exceed the budget.
- [x] **Microcompact** — `microcompactGeminiHistory()` in `context-budget.ts`; rebuilds Gemini chat with `[Old <tool> result cleared by microcompact]` once history exceeds 8 tool turns
- [ ] **Cached microcompact** — `cache_edits` for API without local mutation
- [ ] **Reactive compact** — on-demand compaction after 413 errors (proactive guard catches most cases first)
- [ ] **Context collapse** — progressive context reduction via staged collapses
- [ ] **Snip** — remove old message segments with boundary markers
- [x] **Tool result budget** — `applyToolResultBudget()` + per-tool `TOOL_RESULT_MAX_CHARS` map in `context-budget.ts`; clamps the largest string field, marks `_truncated: true`
- [x] **Tool result persistence** *(Phase 2)* — `store/tool-result-persistence.ts` archives results > 10 KiB serialised to `<sysbasePath>/tool-results/<runId>/<toolId>.json`; budget-clamped result gets `_persistedPath` + `_persistedSize` so the model sees a pointer
- [x] **Token counting/estimation** — rough `estimateTokens()` (chars/4) used by both handlers; CLI mirror in `cli-client/src/agent/token-estimate.ts`
- [x] **Effective context window** — `MODEL_CONTEXT_WINDOWS` map + `getEffectiveContextWindow()` per model
- [x] **Autocompact buffer** — `AUTOCOMPACT_BUFFER_TOKENS = 13_000` plus 10% safety margin in `shouldBlockOnTokens()`. Phase 4 made it flag-tunable via `compaction.autocompact_threshold_buffer`.
- [x] **Circuit breaker for compaction** *(Phase 2)* — `AutocompactCircuitBreaker` opens after 3 consecutive failures per run; recursion guard prevents summary-of-summary.
- [ ] **Post-compact cleanup** — reset microcompact, classifiers, session cache
- [ ] **Prompt cache break detection** — `notifyCompaction` when cache is invalidated
- [ ] **Task budget management** — `taskBudgetRemaining` with adjustments
- [x] **CLAUDE.md project memory** *(Phase 2)* — `services/project-memory.ts` discovers `.sysflow.md` (preferred) or `CLAUDE.md` (fallback) in cwd, parent dir, and `~/.sysflow/MEMORY.md`. mtime-cached, 50k char cap, secret-pattern allowlist. Injected via `prompt/sections/project-memory.ts`.
- [ ] **Memory directory system** (`memdir/`) — persistent cross-session memory
- [ ] **Nested memory attachments** — memory in `ToolUseContext`
- [~] **Git-aware system context** — `env-info.ts` accepts `gitBranch` + truncated `gitStatus` from caller; client doesn't yet send them. Branch + status + recent commits + user name still missing.
- [x] **Date injection** — `env-info.ts` injects local ISO date into the dynamic prompt section
- [ ] **Cache breaker injection** — explicit cache busting when needed
- [ ] **Memoized context with invalidation** — `getUserContext`/`getSystemContext` caching

## TOOL SYSTEM

- [ ] **`buildTool` factory** — merges `TOOL_DEFAULTS` with per-tool definition
- [x] **Zod input schemas** *(Phase 3)* — `cli-client/src/agent/tool-schemas.ts` has one strict schema per tool; `edit_file` is a 4-shape `z.union`. `validateToolInput()` returns parsed args or a structured `ValidationError` with field path + expected shape + recovery hint.
- [ ] **Zod output schemas** on tools with structured output
- [ ] **`validateInput` hook** — semantic validation beyond schema
- [x] **`checkPermissions` hook** *(Phase 3)* — `agent/permissions.ts` `checkPermissions(...)` consults mode > rules > per-tool defaults; returns `allow | deny | ask`. Wired into the executor via `resolvePermission()`.
- [x] **`isConcurrencySafe` flag** *(Phase 2)* — per-tool flag in `agent/tool-meta.ts`; drives `partitionToolCalls()`
- [x] **`isReadOnly` flag** *(Phase 2)* — same source; consumed by `plan` permission mode
- [x] **`maxResultSizeChars`** — per-tool `TOOL_RESULT_MAX_CHARS` map in `services/context-budget.ts`
- [ ] **Tool aliases** — `aliases` array for alternative names
- [ ] **`isEnabled` dynamic gate** — tools can be conditionally available
- [ ] **Tool partitioning** — `partitionToolCalls` groups safe/unsafe batches
- [ ] **Concurrent batch execution** — safe tools run in parallel (max 10)
- [x] **Serial batch execution** *(Phase 2)* — partition's serial group runs one-at-a-time in `executeToolsBatch`
- [ ] **Context modifier queuing** — parallel batch context updates applied in order after batch
- [ ] **StreamingToolExecutor** — execute tools while model is still streaming
- [x] **Sibling abort** *(Phase 2)* — `executeToolsBatch` short-circuits remaining serial siblings with `aborted_by_sibling: true` once a tool with `abortsSiblingsOnError` (currently `run_command`) fails
- [ ] **Tool use summary generation** — `generateToolUseSummary` per turn
- [x] **Tool hooks** *(Phase 3)* — `agent/hooks.ts` with `pre_tool_use`, `post_tool_use`, `post_tool_use_failure` events; `registerHook(event, hook, source)` + `runHooks(event, ctx)` wired into the executor
- [x] **Hook permission override** *(Phase 3)* — `HookResult.override?: PermissionDecision`; first non-undefined override wins; replaces the gate's decision
- [x] **Hook execution prevention** *(Phase 3)* — `HookResult.prevent?: boolean`; first prevent short-circuits but later observer hooks still run
- [ ] **Hook context injection** — hooks can inject additional context (notes accumulate but not threaded back into tool args yet)
- [x] **Structured tool error classification** *(Phase 2)* — `services/tool-error-classifier.ts` `classifyToolError(tool, error)` returns one of 9 categories + a tool-specific recovery hint; `classifyToolErrorFromResult` honours client-set `_errorCategory`
- [x] **Zod validation error formatting** *(Phase 3)* — `validate-tool-input.ts` `formatZodError` returns field path, all issues, expected shape, ready-to-attach hint string
- [ ] **Schema not sent hint** — `buildSchemaNotSentHint` for deferred tools
- [x] **Unknown tool error (not silent conversion)** *(Phase 1 + 3)* — `parseJsonResponse` tracks malformed counts and fails after 2; Zod validation rejects unknown tools with structured ValidationError instead of silent coercion to `list_directory`
- [ ] **GlobTool** — pattern-based file discovery
- [ ] **GrepTool** — ripgrep with pagination, head_limit, offset
- [ ] **WebFetchTool** — URL content fetching
- [ ] **WebBrowserTool** — browser automation
- [ ] **NotebookEditTool** — Jupyter notebook cell editing
- [ ] **AskUserQuestion** — structured questions with options
- [ ] **EnterPlanMode / ExitPlanMode** — plan mode tools
- [ ] **AgentTool** — spawn sub-agents
- [ ] **TaskCreate/Get/Update/List/Output/Stop** — task management tools
- [ ] **SendMessage / ListPeers** — inter-agent communication
- [ ] **SkillTool** — skill discovery and execution
- [ ] **BriefTool** — toggle concise mode
- [ ] **ConfigTool** — runtime configuration
- [ ] **LSPTool** — language server integration
- [ ] **REPLTool** — code execution
- [ ] **PowerShellTool** — Windows-specific shell
- [ ] **SnipTool** — manual history snipping
- [ ] **TerminalCapture** — read terminal output
- [ ] **VerifyPlanExecution** — verify plan was followed
- [ ] **WorkflowTool** — scripted workflows
- [ ] **MonitorTool** — system monitoring
- [ ] **MCP tools** — dynamic external tool integration
- [ ] **Tool sorting for prompt cache stability**
- [ ] **`assembleToolPool`** — unified tool pool with dedup

## ERROR HANDLING & RECOVERY

- [x] **10 retries default** — `withRetry()` in `cli-client/src/agent/retry.ts` defaults to `maxRetries: 10`
- [x] **Exponential backoff with jitter** — `baseDelayMs * 2^attempt + random(0..1000)`, capped at `maxDelayMs` (32 s default), in `retry.ts`
- [ ] **529-specific handling** — separate counter, max 3 before fallback
- [ ] **Persistent retry mode** — unbounded retries for background agents
- [ ] **Heartbeat during retries** — keep-alive for persistent mode
- [ ] **OAuth refresh on 401** — credential refresh and retry
- [ ] **Cloud auth refresh** — AWS Bedrock / GCP Vertex credential refresh
- [~] **Stale connection detection** — `classifyError()` recognises ECONNRESET/EPIPE/ETIMEDOUT as `transient_network`; client-rebuild step still missing
- [ ] **`CannotRetryError`** — explicit give-up signal
- [ ] **`FallbackTriggeredError`** — triggers model switch
- [x] **Max output token recovery** *(Phase 2)* — `BaseProvider.nextMaxOutputAction(runId)` (escalate → continue → fail, max 3); Gemini's `sendWithMaxOutputRecovery` concatenates partial text on `MAX_TOKENS` finishReason
- [ ] **`isWithheldMaxOutputTokens`** — hold errors until recovery decision
- [~] **Context overflow recovery** — 413 → compact → retry. Currently we *prevent* overflow via the pre-API token guard; the reactive `413 → microcompact → retry` path is not yet wired.
- [ ] **`parseMaxTokensContextOverflowError`** — detect and adjust
- [ ] **Streaming error handling** — catch per-chunk, clean up orphans
- [ ] **Orphaned tool_use cleanup** — synthetic tool_results for abandoned tool_use blocks
- [ ] **Image error handling** — `ImageSizeError` / `ImageResizeError` specific types
- [ ] **Abort handling throughout** — `AbortController` in streaming, tools, sub-tasks
- [ ] **Abort reason tracking** — `interrupt`, `sibling_error`, `discard`
- [ ] **Resource cleanup on abort** — MCP, streaming executor, pending promises
- [x] **`shouldRetry` classification** — `classifyError()` returns `usage_limit | rate_limit | session_expired | transient_network | fatal`; controller dispatches per class via the `RetryBudget`
- [ ] **Retry-after header parsing** — honor server's suggested retry delay
- [ ] **Fast mode cooldown** — degraded mode with graceful recovery
- [x] **Per-run malformed-response cap** *(Phase 1 addition, not in original list)* — `BaseProvider.runParseFailures` caps recovery at 2 attempts, then fails with `errorCode: 'malformed_response'`

## PROMPT ENGINEERING

- [x] **Modular section-based system prompt** — 7 sections (`identity`, `system_rules`, `tools`, `task_guidelines`, `output_efficiency`, `env_info`, `model_specific`) under `server/src/providers/prompt/sections/`. Less than the 12+ Claude Code has, but the registry pattern is in place.
- [x] **`SYSTEM_PROMPT_DYNAMIC_BOUNDARY`** — emitted by `buildSystemPrompt()`; `cacheable` and `dynamic` halves are returned alongside `full` so a future Gemini-cache wiring can split on the marker
- [~] **Prompt cache optimization** — sections expose a `cacheable` boolean and a `dynamic` boundary, but providers don't yet pass the cacheable half to a provider-side cache (Gemini `cachedContent` API is a follow-up)
- [ ] **System prompt priority chain** — override → coordinator → agent → custom → default → append
- [~] **Dynamic section registry** — sections are an array with `priority` + `cacheable` + `condition`; not yet a named lookup like `resolveSystemPromptSections`
- [x] **Environment info section** — `env-info.ts` includes cwd, platform, OS, node, model, date; accepts gitBranch/gitStatus from caller (not yet wired through). Knowledge cutoff still missing.
- [ ] **Cyber risk instruction** — security-focused framing
- [ ] **Prompt injection detection instruction** — flag suspicious tool results
- [ ] **Output style system** — configurable response formatting
- [x] **Output efficiency section** — `output-efficiency.ts` contains the conciseness rules
- [ ] **Language preference** — user's preferred language
- [ ] **MCP instructions section** — per-server blocks
- [ ] **Scratchpad instructions** — for working memory
- [ ] **Function result clearing section** — old result handling rules
- [ ] **Tool result summarization rules**
- [ ] **Token budget section** — when budget is active
- [ ] **Brief mode section** — when concise mode is on
- [ ] **Session-specific guidance** — AskUserQuestion, shell tips, agent/explore/skills
- [x] **Model-specific instructions** — `model-specific.ts` switches on model id (`gemini` / `claude` / generic JSON); the old hardcoded Gemini `args_json` blob now lives there as a section, not a string concat in the provider
- [ ] **Proactive/autonomous section** — for autonomous agents

## FILE EDITING

- [ ] **Read-before-edit enforcement** — file must be in `readFileState`
- [ ] **Mtime check** — detect external modifications between read and edit
- [ ] **Content comparison fallback** — for Windows mtime granularity
- [ ] **Partial view detection** — warn if file was only partially read
- [ ] **Multiple match detection** — error when `old_string` isn't unique
- [ ] **Quote normalization** — curly ↔ straight quote matching
- [ ] **`preserveQuoteStyle`** — rewrite `new_string` to match file's quote style
- [ ] **Input sanitization** — strip trailing whitespace, undo API sanitization
- [ ] **Structured patch generation** — `diff` package for structured hunks
- [ ] **Atomic writes** — `writeTextContent` for safe file writes
- [ ] **LSP/editor notifications** — notify language servers after edit
- [ ] **Settings file validation** — special handling for config files
- [ ] **File history integration** — track edit history
- [ ] **`countLinesChanged` analytics** — measure edit impact
- [ ] **Team memory secrets check** — prevent writing secrets to files
- [ ] **1 GiB file size cap** — prevent editing enormous files
- [ ] **UNC path handling** — Windows network path support
- [ ] **Edit ordering enforcement** — no `old_string` in prior `new_string`

## MODEL ROUTING

- [ ] **Multi-level model selection** — user override → allowlist → default by tier → aliases
- [ ] **Runtime model switching** — `getRuntimeMainLoopModel` changes model mid-conversation
- [~] **Plan mode model routing** *(Phase 4)* — plan mode toggle exists (`/plan-mode on|off`, `prompt/sections/plan-mode.ts`); doesn't yet upgrade the model during planning. Pure prompt + permission gate for now.
- [ ] **200k+ token threshold routing** — model change when context is large
- [ ] **Model aliases** — `opus`, `sonnet`, `haiku`, `opusplan`, `best`, `[1m]`
- [ ] **Model allowlist** — `isModelAllowed` filtering
- [ ] **Default by subscription tier** — different defaults for different users
- [ ] **Fast mode with graceful degradation** — cheaper model with fallback
- [ ] **Per-model rate limit tracking** (vs Sysflow's per-provider)
- [ ] **`normalizeModelStringForAPI`** — strip suffixes for API calls

## PERMISSIONS & SAFETY

- [x] **Multi-mode permission system** *(Phase 3)* — `PermissionMode = 'default' | 'auto' | 'plan' | 'bypass'` in `agent/permissions.ts`; persisted in `models.json`; toggled via `/mode <name>` slash command
- [x] **Per-tool `checkPermissions`** *(Phase 3)* — `checkPermissions(...)` returns `allow | deny | ask`; per-tool defaults via `tool-meta.ts.defaultPermission`; wired into the executor via `resolvePermission()`
- [x] **Always-allow / always-deny / always-ask rules** *(Phase 3)* — `Rule[]` persisted in `<sysbasePath>/permissions.json`; longest-pattern-wins via tiny built-in glob matcher (`*` and `**`)
- [x] **Interactive permission prompt** *(Phase 3)* — `cli/permission-prompt.ts` `askPermission()` shows a 4-option box (allow once / Allow always / deny once / Deny always); run-scoped session cache remembers per-run answers
- [ ] **Coordinator permission delegation** — coordinator approves for workers
- [ ] **Swarm worker permissions** — worker-specific permission flow
- [ ] **Bash command classification** — speculative classifier with 2s timeout
- [ ] **Auto-mode with classifier** — AI decides permissions (auto mode currently auto-allows read-only tools but still asks for writes)
- [x] **Deny with explanation** *(Phase 3)* — denial path returns `{ error, _errorCategory: 'permission' }` so the model gets a structured rejection
- [ ] **Cyber risk instruction** — defensive security framing
- [ ] **Prompt injection detection** — flag suspicious content in tool results
- [~] **File write protection** *(Phase 3)* — `builtin/secrets-block` hook denies writes to `.env*`, `*.pem`, `id_rsa*`, `secrets.{json,yaml,toml}`, `credentials.*` (with `.example`/`.sample`/`.template` allowlisted). User-defined glob deny patterns work via `Rule.decision === 'deny'`.
- [~] **Team memory secrets check** *(Phase 2 + 3)* — `services/project-memory.ts` skips files matching common secret patterns; secrets-block hook complements it on writes
- [ ] **Settings file validation** — prevent config corruption
- [x] **Permission logging** *(Phase 3 + 4)* — `builtin/audit` hook appends every tool call (with permission outcome via `_errorCategory`) to `<sysbasePath>/audit-YYYY-MM-DD.jsonl`
- [ ] **Auto-mode denial recording** — `recordAutoModeDenial` for learning

## STREAMING & PERFORMANCE

- [ ] **Token-level streaming** — incremental text deltas to UI
- [ ] **In-process architecture** — no HTTP round-trips in inner loop
- [ ] **Streaming tool execution** — overlap model generation with tool execution
- [ ] **Prompt cache optimization** — reuse cached prompt tokens (boundary exists; cache plumbing does not)
- [x] **`SYSTEM_PROMPT_DYNAMIC_BOUNDARY`** for cache splitting — emitted by `buildSystemPrompt()`
- [ ] **Background processing** — skill prefetch, post-sampling hooks, summary generation
- [ ] **Configurable concurrency** — `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY`
- [x] **Token warning system** — pre-API blocking limit check via `shouldBlockOnTokens()` in both handlers
- [ ] **Microcompact cache edits** — avoid re-sending cleared content (we replace history rather than emit `cache_edits`)

## MULTI-AGENT & TASKS

- [ ] **Coordinator mode** — dedicated coordinator role with specialized prompt
- [ ] **Sub-agent spawning** — `AgentTool` creates autonomous workers
- [ ] **Inter-agent messaging** — `SendMessage` / `ListPeers`
- [ ] **Background task system** — create, track, update, list, stop tasks
- [ ] **Token budget per task** — `taskBudgetRemaining`
- [ ] **Task summary module** — background session summaries
- [ ] **Swarm mode** — team create/delete, specialized workers
- [ ] **Skill system** — composable, reusable task patterns
- [ ] **Skill discovery prefetch** — proactive skill loading
- [ ] **Plan mode as a tool** — model chooses when to plan
- [ ] **Workflow system** — scripted multi-step flows
- [ ] **Proactive/autonomous mode** — background processing with pacing
- [ ] **Sleep tool** — pacing for autonomous agents
- [ ] **Push notifications** — alert user when attention needed

## SEARCH & NAVIGATION

- [ ] **Ripgrep integration** — fast regex search with structured output
- [ ] **Pagination** — `head_limit` + `offset` for large result sets
- [ ] **Glob tool** — dedicated file pattern discovery
- [ ] **WebFetch** — URL content to readable markdown
- [ ] **WebBrowser** — full browser automation
- [ ] **LSP integration** — go to definition, find references, diagnostics
- [ ] **Terminal capture** — read terminal output
- [ ] **Tool search** — meta-tool for discovering available tools
- [ ] **Result size caps on search** — prevent enormous search results

## TESTING & RELIABILITY

- [x] **Any tests at all** *(Phase 4)* — vitest configured on both packages, ~30 cases across `validate-tool-input`, `permissions`, `hooks`, `tool-meta`, `context-budget`, `project-memory`, `tool-error-classifier`. `npm test` / `npm run test:watch` in each package.
- [ ] **Biome/ESLint** for code quality enforcement
- [x] **Feature flag system** *(Phase 4)* — typed registries on both packages; three-source precedence `SYSFLOW_FLAG_<NAME>` env > `<sysbasePath>/flags.json` > registered default. Memoised + mtime-cached.
- [ ] **Progressive rollout** — enable features for subsets of users
- [ ] **A/B testing** — different strategies for different users
- [x] **Circuit breakers** *(Phase 2)* — `AutocompactCircuitBreaker` opens after 3 consecutive autocompact failures per run
- [ ] **Abort system** — `AbortController` throughout
- [ ] **Structured error types** — `CannotRetryError`, `FallbackTriggeredError`, etc.
- [~] **Telemetry / OTel** *(Phase 4)* — per-run usage summary appended to `<sysbasePath>/usage.jsonl` with model, durations, tool/error counts, est. tokens, terminal reason. No OTel spans; this is a flat-file telemetry seed.
- [x] **Tool validation pipeline** *(Phase 1 + 3)* — schema (Zod) → permission gate (rule + mode + hooks) → execute. Three layers in `executeToolLocally`.
- [x] **Hook system for testing** *(Phase 3)* — `clearHooks(event?)` resets the registry between tests; the test suite (`hooks.test.ts`) demonstrates the pattern
- [~] **Multiple recovery paths** *(Phases 1–2)* — retries by class (rate_limit / usage_limit / failure / completion_rejection / malformed) via `RetryBudget`; max-output-token recovery (escalate→continue→fail); autocompact + microcompact + tool-result archival on size pressure

## ARCHITECTURE & EXTENSIBILITY

- [ ] **Event-driven core** — async generator yielding typed events
- [ ] **Multiple interfaces** — CLI + Web UI + SDK
- [ ] **MCP integration** — dynamic external tool integration
- [~] **Plugin architecture** *(Phase 3)* — hook registry exists (`pre_tool_use`, `post_tool_use`, `post_tool_use_failure`); MCP and skills still missing as plugin points
- [~] **Configuration schema** *(Phases 3–4)* — Zod 3 validated tool inputs; permissions / flags use plain JSON validators (not Zod schemas yet)
- [ ] **Schema migrations** — config evolution without breaking
- [ ] **Dependency injection** — not hardcoded service imports
- [~] **Pipeline pattern** *(Phases 1–3)* — modular prompt sections compose by priority + cacheable boundary; tool execution pipeline goes through validation → hooks → permission → dispatch → post-hooks. Not a generalised pipeline framework.
- [ ] **Bridge/channel communication** — inter-component messaging
- [ ] **Component library** — Ink/React components for CLI
- [~] **Persistent memory** *(Phase 2)* — `.sysflow.md` discovery + 50k char cap; not yet a true `memdir/` with cross-session attachments
- [x] **File-based project config** *(Phase 2)* — `.sysflow.md` is the canonical project memory file; `<sysbasePath>/permissions.json` + `flags.json` carry per-project config

---

## PHASE 1–4 ADDITIONS (not in the original 227-item list)

Concrete improvements landed across the four passes that don't map cleanly onto a Claude-Code feature but improve Sysflow's reliability, UX, or operability:

- [x] **Stable `errorCode` taxonomy on `ClientResponse`** *(Phase 1)* — replaces `error.message` regex matching in the CLI controller
- [x] **CLI render extraction** *(Phase 1)* — rendering primitives in `cli/render.ts`
- [x] **CLI diff-preview extraction** *(Phase 1)* — Tab-keypress diff expansion in `cli/diff-preview.ts`
- [x] **CLI tool-result preview** *(Phase 1)* — one-liner per tool replacing the silent spinner gap
- [x] **State-machine dispatch in CLI loop** *(Phase 1)* — typed `Transition` switch instead of nested string ifs
- [x] **Single `RetryBudget`** *(Phase 1)* — replaces four scattered retry counters
- [x] **`withRetry` helper** *(Phase 1)* — classification-aware backoff, default 10 retries / 32s cap + jitter
- [x] **Per-run malformed-response counter** *(Phase 1)* — caps the silent-recovery loop at 2 attempts
- [x] **Tool-meta partition + sibling abort** *(Phase 2)* — `tool-meta.ts` declares `isConcurrencySafe` + `abortsSiblingsOnError`; serial siblings short-circuit with `aborted_by_sibling: true`
- [x] **Pre-budget archive + post-budget pointer** *(Phase 2)* — `_persistedPath` + `_persistedSize` on the model-visible result point at the full archived payload
- [x] **`/mode` and `/permissions` slash commands** *(Phase 3)* — REPL controls for the permission system
- [x] **`/plan-mode` slash command** *(Phase 4)* — toggle plus REPL header indicator
- [x] **Daily-rotated audit log** *(Phase 4)* — `<sysbasePath>/audit-YYYY-MM-DD.jsonl` with retention pruning
- [x] **Per-run usage telemetry** *(Phase 4)* — `<sysbasePath>/usage.jsonl` summary per terminal exit
- [x] **Built-in `builtin/secrets-block` hook** *(Phase 3)* — denies writes to `.env*`, `*.pem`, `id_rsa*`, etc.
- [x] **Vitest test suite** *(Phase 4)* — ~30 cases across the pure modules introduced in Phases 1–3

## TOTAL COUNT

| Category | Items Claude Code Has | Implemented | Partial | Still Missing |
|----------|----------------------|-------------|---------|---------------|
| Agent Loop | 11 | 1 | 3 | 7 |
| Context & Memory | 21 | 8 | 1 | 12 |
| Tool System | 51 | 9 | 0 | 42 |
| Error Handling | 23 | 5 | 2 | 16 |
| Prompt Engineering | 21 | 4 | 2 | 15 |
| File Editing | 18 | 0 | 0 | 18 |
| Model Routing | 10 | 0 | 1 | 9 |
| Permissions & Safety | 16 | 6 | 2 | 8 |
| Streaming & Performance | 9 | 2 | 0 | 7 |
| Multi-Agent & Tasks | 14 | 0 | 0 | 14 |
| Search & Navigation | 9 | 0 | 0 | 9 |
| Testing & Reliability | 12 | 5 | 2 | 5 |
| Architecture | 12 | 1 | 4 | 7 |
| **TOTAL** | **227** | **41** | **17** | **169** |

Plus 16 **Phase 1–4 additions** outside the original list (see above).

The 41 fully-implemented + 17 partial items close the most-cited reliability gaps across all four phases: pre-API token guard, microcompact, real autocompact + circuit breaker, tool-result budget + archival, modular prompt sections + plan-mode, project memory, retry classification + max-output-token recovery, Zod validation + structured permission system + interactive prompt + persistent rules, hook registry with built-in secrets-block + audit, daily-rotated audit log, per-run usage telemetry, vitest suite over the pure modules. The remaining ~169 items are real follow-up work — biggest gaps are still File Editing (18), Tool System extras (42, mostly the auxiliary tools like Glob/Grep/WebFetch/AgentTool/MCP), Multi-Agent (14), and Search & Navigation (9). See `00-executive-summary.md` for the phased roadmap and the Phase 5+ sketch in each applied plan's "Follow-ups" section.
