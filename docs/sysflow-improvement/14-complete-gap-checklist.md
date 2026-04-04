# 14 — Complete Gap Checklist: Everything Claude Code Has That Sysflow AI Lacks

This is the exhaustive, line-by-line inventory. Every item is something Claude Code implements that Sysflow AI either completely lacks or implements at a fraction of the quality.

---

## AGENT LOOP & ORCHESTRATION

- [ ] **Async generator loop** — `queryLoop` yields events, Sysflow uses request-response
- [ ] **StreamEvent system** — typed events for every lifecycle step
- [ ] **30+ step loop body** — compaction, token checks, streaming, tools, hooks, limits per iteration
- [ ] **Explicit terminal reasons** — `completed`, `blocking_limit`, `prompt_too_long`, `model_error`, `aborted_streaming`, `aborted_tools`, `stop_hook_prevented`, `hook_stopped`, `max_turns`
- [ ] **Explicit continue reasons** — `collapse_drain_retry`, `reactive_compact_retry`, `max_output_tokens_escalate`, `max_output_tokens_recovery`, `stop_hook_blocking`, `token_budget_continuation`, `next_turn`
- [ ] **Pre-API token guard** — `calculateTokenWarningState` prevents wasted API calls
- [ ] **Max turns limit** — configurable cap on loop iterations
- [ ] **Turn counter and tracking** — `turnCount`, `turnId`, `turnCounter` analytics
- [ ] **Query chain tracking** — `chainId`, depth tracking across compactions
- [ ] **Attachment queue** — `getCommandsByMaxPriority`, `getAttachmentMessages`, priority-based
- [ ] **Fallback model switch mid-stream** — `FallbackTriggeredError` handling with cleanup

## CONTEXT & MEMORY

- [ ] **Autocompact** — proactive compaction when near token limit
- [ ] **Microcompact** — clear old tool results with `[Old tool result content cleared]`
- [ ] **Cached microcompact** — `cache_edits` for API without local mutation
- [ ] **Reactive compact** — on-demand compaction after 413 errors
- [ ] **Context collapse** — progressive context reduction via staged collapses
- [ ] **Snip** — remove old message segments with boundary markers
- [ ] **Tool result budget** — per-tool `maxResultSizeChars` (e.g., FileEdit = 100k)
- [ ] **Tool result persistence** — large results stored to disk, replaced with previews
- [ ] **Token counting/estimation** — `tokenCountWithEstimation` throughout
- [ ] **Effective context window** — per-model context window minus reserved output
- [ ] **Autocompact buffer** — 13k tokens reserved for safety margin
- [ ] **Circuit breaker for compaction** — 3 consecutive failures → stop trying
- [ ] **Post-compact cleanup** — reset microcompact, classifiers, session cache
- [ ] **Prompt cache break detection** — `notifyCompaction` when cache is invalidated
- [ ] **Task budget management** — `taskBudgetRemaining` with adjustments
- [ ] **CLAUDE.md project memory** — file-based, user-editable, per-project instructions
- [ ] **Memory directory system** (`memdir/`) — persistent cross-session memory
- [ ] **Nested memory attachments** — memory in `ToolUseContext`
- [ ] **Git-aware system context** — branch, status, recent commits, user name
- [ ] **Date injection** — local ISO date always in context
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

- [ ] **10 retries default** (vs Sysflow's 3-4)
- [ ] **Exponential backoff with jitter** — `BASE_DELAY * 2^attempt + random`
- [ ] **529-specific handling** — separate counter, max 3 before fallback
- [ ] **Persistent retry mode** — unbounded retries for background agents
- [ ] **Heartbeat during retries** — keep-alive for persistent mode
- [ ] **OAuth refresh on 401** — credential refresh and retry
- [ ] **Cloud auth refresh** — AWS Bedrock / GCP Vertex credential refresh
- [ ] **Stale connection detection** — ECONNRESET/EPIPE → fresh client
- [ ] **`CannotRetryError`** — explicit give-up signal
- [ ] **`FallbackTriggeredError`** — triggers model switch
- [ ] **Max output token recovery** — 3 attempts: escalate → continue message
- [ ] **`isWithheldMaxOutputTokens`** — hold errors until recovery decision
- [ ] **Context overflow recovery** — 413 → compact → retry
- [ ] **`parseMaxTokensContextOverflowError`** — detect and adjust
- [ ] **Streaming error handling** — catch per-chunk, clean up orphans
- [ ] **Orphaned tool_use cleanup** — synthetic tool_results for abandoned tool_use blocks
- [ ] **Image error handling** — `ImageSizeError` / `ImageResizeError` specific types
- [ ] **Abort handling throughout** — `AbortController` in streaming, tools, sub-tasks
- [ ] **Abort reason tracking** — `interrupt`, `sibling_error`, `discard`
- [ ] **Resource cleanup on abort** — MCP, streaming executor, pending promises
- [ ] **`shouldRetry` classification** — not just rate limits, also 5xx, connection, auth
- [ ] **Retry-after header parsing** — honor server's suggested retry delay
- [ ] **Fast mode cooldown** — degraded mode with graceful recovery

## PROMPT ENGINEERING

- [ ] **Modular section-based system prompt** — 12+ named sections
- [ ] **`SYSTEM_PROMPT_DYNAMIC_BOUNDARY`** — cache split marker
- [ ] **Prompt cache optimization** — three-part cache key
- [ ] **System prompt priority chain** — override → coordinator → agent → custom → default → append
- [ ] **Dynamic section registry** — `resolveSystemPromptSections` with named entries
- [ ] **Environment info section** — cwd, git, platform, shell, OS, model, knowledge cutoff
- [ ] **Cyber risk instruction** — security-focused framing
- [ ] **Prompt injection detection instruction** — flag suspicious tool results
- [ ] **Output style system** — configurable response formatting
- [ ] **Output efficiency section** — conciseness guidelines
- [ ] **Language preference** — user's preferred language
- [ ] **MCP instructions section** — per-server blocks
- [ ] **Scratchpad instructions** — for working memory
- [ ] **Function result clearing section** — old result handling rules
- [ ] **Tool result summarization rules**
- [ ] **Token budget section** — when budget is active
- [ ] **Brief mode section** — when concise mode is on
- [ ] **Session-specific guidance** — AskUserQuestion, shell tips, agent/explore/skills
- [ ] **Model-specific instructions** — different guidance per model family
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
- [ ] **Prompt cache optimization** — reuse cached prompt tokens
- [ ] **`SYSTEM_PROMPT_DYNAMIC_BOUNDARY`** for cache splitting
- [ ] **Background processing** — skill prefetch, post-sampling hooks, summary generation
- [ ] **Configurable concurrency** — `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY`
- [ ] **Token warning system** — pre-API blocking limit check
- [ ] **Microcompact cache edits** — avoid re-sending cleared content

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

## TOTAL COUNT

| Category | Items Claude Code Has | Items Sysflow AI Lacks |
|----------|----------------------|----------------------|
| Agent Loop | 11 | 11 |
| Context & Memory | 21 | 21 |
| Tool System | 51 | 51 |
| Error Handling | 23 | 23 |
| Prompt Engineering | 21 | 21 |
| File Editing | 18 | 18 |
| Model Routing | 10 | 10 |
| Permissions & Safety | 16 | 16 |
| Streaming & Performance | 9 | 9 |
| Multi-Agent & Tasks | 14 | 14 |
| Search & Navigation | 9 | 9 |
| Testing & Reliability | 12 | 12 |
| Architecture | 12 | 12 |
| **TOTAL** | **227** | **227** |

Every single item above is something concrete that Claude Code implements and Sysflow AI either completely lacks or has a fragile/incomplete version of. This is not about the model — it's about the **227 orchestrator-level capabilities** that make Claude Code reliable.
