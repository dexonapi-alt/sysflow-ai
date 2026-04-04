# 01 — Agent Loop & Orchestration

## What Claude Code Has

### Async Generator Architecture
Claude Code's agent loop (`query.ts`) is an **async generator** (`queryLoop`) that **yields events** throughout its lifecycle. This enables:
- Real-time streaming of events to the UI (`stream_request_start`, tool progress, compaction notices)
- Clean cancellation via `AbortController` integration
- Composable event processing (the caller decides what to do with each event)

### 30+ Step Loop Body (Per Iteration)
Each iteration of `queryLoop` performs:
1. Prefetch skill discovery
2. Yield `stream_request_start` for profiling
3. Build query tracking (chain ID, depth)
4. Get messages after compact boundary
5. Apply tool result budget
6. Run snip compaction if needed
7. Run microcompact
8. Run context collapse if needed
9. Build full system prompt with context appended
10. Run autocompact with circuit breaker (3 consecutive failures)
11. Post-compact message building and yield
12. Initialize StreamingToolExecutor if enabled
13. Resolve runtime model (plan mode, 200k+ heuristic)
14. Check blocking token limit (pre-API guard)
15. Stream API call with fallback model support
16. Process streaming events with tool backfill
17. Withhold certain errors for recovery decisions
18. Handle cached microcompact boundaries
19. Handle FallbackTriggeredError with model switch
20. Execute post-sampling hooks
21. Handle abort scenarios (streaming vs tools)
22. Resolve pending tool-use summaries from prior turn
23. Determine terminal vs continue reason
24. Recovery paths: context collapse, reactive compact, max output token escalation
25. Handle stop hooks (prevent, block, allow)
26. Check token budget continuation
27. Execute tools (streaming or batched)
28. Process attachments and queued commands
29. Generate tool-use summaries
30. Check max turns limit
31. Build next state

### Explicit Terminal vs Continue Reasons
Every loop exit is categorized:

**Terminal reasons:** `completed`, `blocking_limit`, `image_error`, `model_error`, `aborted_streaming`, `aborted_tools`, `prompt_too_long`, `stop_hook_prevented`, `hook_stopped`, `max_turns`

**Continue reasons:** `collapse_drain_retry`, `reactive_compact_retry`, `max_output_tokens_escalate`, `max_output_tokens_recovery`, `stop_hook_blocking`, `token_budget_continuation`, `next_turn`

### Streaming Tool Execution
Tools can begin executing **while the model is still generating**:
- `StreamingToolExecutor` receives tool blocks as they stream in
- Concurrency-safe tools run in parallel immediately
- Unsafe tools queue and execute serially
- Sibling abort: if a Bash tool errors, sibling tools are aborted
- Results are yielded as they complete, maintaining order

### Fallback Model Support During Streaming
If the primary model fails mid-stream:
- `FallbackTriggeredError` caught
- Switch to fallback model
- Tombstone orphaned assistant messages
- Yield missing tool_result blocks
- Discard streaming executor, create new one
- Strip signatures, log, yield warning
- **Continue** the loop with the new model

---

## What Sysflow AI Has (Gaps)

### Simple Request-Response Loop
Sysflow's agent loop (`cli-client/src/agent/agent.ts` `runAgent`) is a basic `while(true)` with:
- `callServerStream` / `callServer` for each turn
- Switch on `response.status` (completed, waiting_for_user, failed, needs_tool)
- No yielding of events, no async generator
- No streaming tool execution
- No mid-loop compaction
- No abort handling

### No Event System
- The loop doesn't yield events; it processes in-band
- No `stream_request_start` or progress tracking
- No clean cancellation (relies on process exit or `Ctrl+C`)
- Pipeline display is hacked into the loop, not event-driven

### No Pre-API Guards
- No blocking token limit check before calling the API
- Can waste API calls on prompts that are too long
- No token budget management

### No Streaming Tool Execution
- Tools execute only after the full model response returns
- Serial execution by default (parallel only for batches)
- No sibling abort mechanism
- No concurrent safety classification

### No Fallback During Streaming
- Fallback only happens on rate limit, not mid-stream
- No model switch + retry within the same turn
- No orphan message cleanup

### Limited Terminal/Continue Categorization
- Only checks: `completed`, `waiting_for_user`, `failed`, `needs_tool`
- No `blocking_limit`, `prompt_too_long`, `max_turns` etc.
- No recovery paths for context overflow

### Client-Server Split Adds Latency
- CLI sends HTTP to server for each model call
- Server calls model, returns response
- CLI executes tools locally, sends results back
- **3 HTTP round-trips per tool turn** vs Claude Code's in-process loop

---

## What to Implement

### Priority 1: Async Generator Loop
```typescript
async function* queryLoop(params: QueryParams): AsyncGenerator<StreamEvent> {
  let state = initializeState(params);
  
  while (true) {
    yield { type: 'stream_request_start', turnCount: state.turnCount };
    
    // Pre-API compaction pipeline
    state.messages = await applyToolResultBudget(state.messages);
    state.messages = await microcompact(state.messages);
    const compactResult = await autocompactIfNeeded(state);
    if (compactResult) {
      yield { type: 'compaction', summary: compactResult.summary };
      state.messages = compactResult.messages;
    }
    
    // Pre-API token guard
    const tokenState = calculateTokenWarningState(state.messages);
    if (tokenState.isAtBlockingLimit) {
      yield { type: 'error', message: 'Context too large' };
      return { reason: 'blocking_limit' };
    }
    
    // Stream API call
    const stream = callModel(state);
    const toolUseBlocks = [];
    
    for await (const event of stream) {
      yield event; // Forward to UI
      if (event.type === 'tool_use') {
        toolUseBlocks.push(event.block);
        if (streamingExecutor) {
          streamingExecutor.addTool(event.block);
          for (const result of streamingExecutor.getCompletedResults()) {
            yield result;
          }
        }
      }
    }
    
    // Determine continuation
    if (toolUseBlocks.length === 0) {
      // Recovery paths...
      return { reason: 'completed' };
    }
    
    // Execute remaining tools
    const toolResults = streamingExecutor 
      ? await streamingExecutor.getRemainingResults()
      : await runTools(toolUseBlocks, state.context);
    
    for (const result of toolResults) yield result;
    
    // Check limits
    if (++state.turnCount > state.maxTurns) {
      return { reason: 'max_turns' };
    }
    
    state = buildNextState(state, toolResults);
  }
}
```

### Priority 2: Explicit Transition System
```typescript
type TerminalReason = 
  | 'completed' | 'blocking_limit' | 'prompt_too_long'
  | 'model_error' | 'aborted' | 'max_turns' | 'hook_prevented';

type ContinueReason = 
  | 'next_turn' | 'compact_retry' | 'max_tokens_recovery'
  | 'token_budget_continuation';

type Transition = 
  | { terminal: true; reason: TerminalReason }
  | { terminal: false; reason: ContinueReason };
```

### Priority 3: Streaming Tool Executor
Implement `StreamingToolExecutor` that:
- Accepts tool blocks as they arrive from the model stream
- Classifies each as concurrency-safe or not
- Runs safe tools in parallel immediately
- Queues unsafe tools for serial execution
- Aborts sibling tools on Bash error
- Returns results in order

### Priority 4: Pre-API Token Guard
Before every API call:
- Estimate token count of current message array
- If at blocking limit, return error without wasting an API call
- If near limit, trigger proactive compaction
