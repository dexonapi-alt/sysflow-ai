# 14 — Complete Gap Checklist: Everything Claude Code Has That Sysflow AI Lacks

This is the exhaustive, line-by-line inventory. Every item is something Claude Code implements that Sysflow AI either completely lacks or implements at a fraction of the quality.

> **Legend:** `[x]` = implemented in this repo · `[~]` = partial / subset implemented · `[ ]` = not yet
> **2026-05-02 Phase 1 pass:** see `.claude/plans/applied/2026-05-02-phase-1-reasoning-and-cli-ux.md` for what landed.

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

## CONTEXT & MEMORY

- [ ] **Autocompact** — proactive compaction when near token limit (model-driven summarisation; only the trigger threshold is in place)
- [x] **Microcompact** — `microcompactGeminiHistory()` in `context-budget.ts`; rebuilds Gemini chat with `[Old <tool> result cleared by microcompact]` once history exceeds 8 tool turns
- [ ] **Cached microcompact** — `cache_edits` for API without local mutation
- [ ] **Reactive compact** — on-demand compaction after 413 errors
- [ ] **Context collapse** — progressive context reduction via staged collapses
- [ ] **Snip** — remove old message segments with boundary markers
- [x] **Tool result budget** — `applyToolResultBudget()` + per-tool `TOOL_RESULT_MAX_CHARS` map in `context-budget.ts`; clamps the largest string field, marks `_truncated: true`
- [ ] **Tool result persistence** — large results stored to disk, replaced with previews
- [x] **Token counting/estimation** — rough `estimateTokens()` (chars/4) used by both handlers
- [x] **Effective context window** — `MODEL_CONTEXT_WINDOWS` map + `getEffectiveContextWindow()` per model
- [x] **Autocompact buffer** — `AUTOCOMPACT_BUFFER_TOKENS = 13_000` plus 10% safety margin in `shouldBlockOnTokens()`
- [ ] **Circuit breaker for compaction** — 3 consecutive failures → stop trying
- [ ] **Post-compact cleanup** — reset microcompact, classifiers, session cache
- [ ] **Prompt cache break detection** — `notifyCompaction` when cache is invalidated
- [ ] **Task budget management** — `taskBudgetRemaining` with adjustments
- [ ] **CLAUDE.md project memory** — file-based, user-editable, per-project instructions
- [ ] **Memory directory system** (`memdir/`) — persistent cross-session memory
- [ ] **Nested memory attachments** — memory in `ToolUseContext`
- [~] **Git-aware system context** — `env-info.ts` accepts `gitBranch` + truncated `gitStatus` from caller; client doesn't yet send them. Branch + status + recent commits + user name still missing.
- [x] **Date injection** — `env-info.ts` injects local ISO date into the dynamic prompt section
- [ ] **Cache breaker injection** — explicit cache busting when needed
- [ ] **Memoized context with invalidation** — `getUserContext`/`getSystemContext` caching

## TOOL SYSTEM

- [ ] **`buildTool` factory** — merges `TOOL_DEFAULTS` with per-tool definition
- [ ] **Zod input schemas** on every tool
- [ ] **Zod output schemas** on tools with structured output
- [ ] **`validateInput` hook** — semantic validation beyond schema
- [ ] **`checkPermissions` hook** — per-tool authorization
- [ ] **`isConcurrencySafe` flag** — per-tool concurrency classification
- [ ] **`isReadOnly` flag** — marks tools that don't modify state
- [ ] **`maxResultSizeChars`** — per-tool output size cap
- [ ] **Tool aliases** — `aliases` array for alternative names
- [ ] **`isEnabled` dynamic gate** — tools can be conditionally available
- [ ] **Tool partitioning** — `partitionToolCalls` groups safe/unsafe batches
- [ ] **Concurrent batch execution** — safe tools run in parallel (max 10)
- [ ] **Serial batch execution** — unsafe tools run one-at-a-time
- [ ] **Context modifier queuing** — parallel batch context updates applied in order after batch
- [ ] **StreamingToolExecutor** — execute tools while model is still streaming
- [ ] **Sibling abort** — Bash error aborts sibling tools
- [ ] **Tool use summary generation** — `generateToolUseSummary` per turn
- [ ] **Tool hooks** — `runPreToolUseHooks`, `runPostToolUseHooks`, `runPostToolUseFailureHooks`
- [ ] **Hook permission override** — hooks can change permission decisions
- [ ] **Hook execution prevention** — hooks can stop tool execution
- [ ] **Hook context injection** — hooks can inject additional context
- [ ] **Structured tool error classification** — `classifyToolError` taxonomy
- [ ] **Zod validation error formatting** — `formatZodValidationError` with schema hint
- [ ] **Schema not sent hint** — `buildSchemaNotSentHint` for deferred tools
- [ ] **Unknown tool error (not silent conversion)** — returns error, doesn't convert to `list_directory`
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
- [ ] **Max output token recovery** — 3 attempts: escalate → continue message
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
- [ ] **Plan mode model routing** — upgrade model during planning
- [ ] **200k+ token threshold routing** — model change when context is large
- [ ] **Model aliases** — `opus`, `sonnet`, `haiku`, `opusplan`, `best`, `[1m]`
- [ ] **Model allowlist** — `isModelAllowed` filtering
- [ ] **Default by subscription tier** — different defaults for different users
- [ ] **Fast mode with graceful degradation** — cheaper model with fallback
- [ ] **Per-model rate limit tracking** (vs Sysflow's per-provider)
- [ ] **`normalizeModelStringForAPI`** — strip suffixes for API calls

## PERMISSIONS & SAFETY

- [ ] **Multi-mode permission system** — default, plan, bypass, auto
- [ ] **Per-tool `checkPermissions`** — `allow | deny | ask`
- [ ] **Always-allow / always-deny / always-ask rules** — glob patterns
- [ ] **Interactive permission prompt** — ask user before dangerous operations
- [ ] **Coordinator permission delegation** — coordinator approves for workers
- [ ] **Swarm worker permissions** — worker-specific permission flow
- [ ] **Bash command classification** — speculative classifier with 2s timeout
- [ ] **Auto-mode with classifier** — AI decides permissions
- [ ] **Deny with explanation** — error includes why tool was denied
- [ ] **Cyber risk instruction** — defensive security framing
- [ ] **Prompt injection detection** — flag suspicious content in tool results
- [ ] **File write protection** — glob-based deny patterns
- [ ] **Team memory secrets check** — prevent writing secrets
- [ ] **Settings file validation** — prevent config corruption
- [ ] **Permission logging** — `logPermissionDecision` for audit
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

- [ ] **Any tests at all** — unit, integration, or e2e
- [ ] **Biome/ESLint** for code quality enforcement
- [ ] **Feature flag system** — compile-time and runtime flags
- [ ] **Progressive rollout** — enable features for subsets of users
- [ ] **A/B testing** — different strategies for different users
- [ ] **Circuit breakers** — stop retrying broken subsystems
- [ ] **Abort system** — `AbortController` throughout
- [ ] **Structured error types** — `CannotRetryError`, `FallbackTriggeredError`, etc.
- [ ] **Telemetry / OTel** — spans, metrics, analytics
- [ ] **Tool validation pipeline** — schema → semantic → permission (3 layers)
- [ ] **Hook system for testing** — inject test behavior via hooks
- [ ] **Multiple recovery paths** — 2-3 options per failure type

## ARCHITECTURE & EXTENSIBILITY

- [ ] **Event-driven core** — async generator yielding typed events
- [ ] **Multiple interfaces** — CLI + Web UI + SDK
- [ ] **MCP integration** — dynamic external tool integration
- [ ] **Plugin architecture** — hooks, skills, MCP as plugin points
- [ ] **Configuration schema** — Zod v4 validated config
- [ ] **Schema migrations** — config evolution without breaking
- [ ] **Dependency injection** — not hardcoded service imports
- [ ] **Pipeline pattern** — composable processing stages
- [ ] **Bridge/channel communication** — inter-component messaging
- [ ] **Component library** — Ink/React components for CLI
- [ ] **Persistent memory** — survives restarts
- [ ] **File-based project config** — `.sysflow.md` or similar

---

## PHASE 1 ADDITIONS (not in the original 227-item list)

These are concrete improvements landed in `2026-05-02-phase-1-reasoning-and-cli-ux` that don't map cleanly onto a Claude-Code feature but improve Sysflow's reliability or UX in their own right.

- [x] **Stable `errorCode` taxonomy on `ClientResponse`** (`usage_limit | rate_limit | session_expired | prompt_too_long | malformed_response | unknown`). Replaces string-matching `error.message` in the CLI controller.
- [x] **CLI render extraction**: rendering primitives (`colors`, `BOX`, `boxTop/Mid/Bot`, `revealReasoning`, `formatToolLabel`, `renderMarkdown`, `renderPipelineBox`, `printStepTransition`) live in `cli-client/src/cli/render.ts` — pure functions, no module-level state.
- [x] **CLI diff-preview extraction**: Tab-keypress diff expansion and listener lifecycle in `cli-client/src/cli/diff-preview.ts`.
- [x] **CLI tool-result preview**: each tool now prints a one-line preview (`renderToolResultPreview`) between execution and the next model call — first 3 lines for reads, exit code + last stdout line for commands, match count for searches, byte count for writes. Replaces the silent "thinking..." spinner gap.
- [x] **State-machine dispatch in CLI loop**: `classifyResponse()` returns a typed `Transition`; the controller is a switch on `transition.reason` instead of nested `if/else` on string fields.
- [x] **Single `RetryBudget`**: replaces the four scattered retry counters (`initialAttempts`, `rateLimitRetries`, `failureRetries`, `clientCompletionRejections`) in the old agent.ts with one struct keyed by retry class.
- [x] **`withRetry` helper** with classification-aware backoff (`cli-client/src/agent/retry.ts`). Defaults to 10 retries, caps at 32 s + jitter.
- [x] **Per-run malformed-response counter** (`BaseProvider.runParseFailures`, max 2). Caps the silent-recovery loop that previously coerced any unparseable response into a `list_directory` call forever.

## TOTAL COUNT

| Category | Items Claude Code Has | Phase 1 Implemented | Phase 1 Partial | Still Missing |
|----------|----------------------|---------------------|-----------------|---------------|
| Agent Loop | 11 | 1 | 2 | 8 |
| Context & Memory | 21 | 5 | 1 | 15 |
| Tool System | 51 | 0 | 0 | 51 |
| Error Handling | 23 | 3 | 2 | 18 |
| Prompt Engineering | 21 | 4 | 2 | 15 |
| File Editing | 18 | 0 | 0 | 18 |
| Model Routing | 10 | 0 | 0 | 10 |
| Permissions & Safety | 16 | 0 | 0 | 16 |
| Streaming & Performance | 9 | 2 | 0 | 7 |
| Multi-Agent & Tasks | 14 | 0 | 0 | 14 |
| Search & Navigation | 9 | 0 | 0 | 9 |
| Testing & Reliability | 12 | 0 | 0 | 12 |
| Architecture | 12 | 0 | 0 | 12 |
| **TOTAL** | **227** | **15** | **7** | **205** |

Plus 8 **Phase 1 additions** outside the original list (see above).

Every unchecked item above is something concrete that Claude Code implements and Sysflow AI either completely lacks or has a fragile/incomplete version of. The 15 fully-implemented items from Phase 1 close the most-cited reliability gaps (token guard, microcompact, tool-result budget, modular prompt, retry classification). The remaining ~205 items are real follow-up work — see `00-executive-summary.md` for the phased roadmap.
