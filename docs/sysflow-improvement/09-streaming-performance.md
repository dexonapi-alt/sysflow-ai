# 09 — Streaming & Performance

## What Claude Code Has

### True Token-Level Streaming
- `claude.ts` constructs streaming requests, processes deltas as they arrive
- Each token/chunk is yielded as a `StreamEvent`
- UI renders tokens in real-time as the model generates
- Tool use blocks detected mid-stream, enabling streaming tool execution

### Streaming Tool Execution (Overlapped)
- `StreamingToolExecutor` starts executing tools **before the model finishes generating**
- When a tool_use block is complete in the stream, execution begins immediately
- Concurrency-safe tools run in parallel
- This can save **seconds per turn** — tool execution overlaps with model generation
- Results yielded in order as they complete

### In-Process Architecture
- CLI and model calling happen in the same process (Bun runtime)
- No HTTP round-trips between CLI and server for each turn
- Tool execution is local, results passed in-memory
- Eliminates network latency from the inner loop

### Prompt Cache Optimization
- `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` splits cacheable vs dynamic prompt sections
- Tools sorted by name for cache key stability
- Three-part cache key: system prompt + user context + system context
- Repeated turns reuse cached prompt tokens → lower latency and cost
- `notifyCompaction` for prompt-cache break detection

### Efficient Context Management
- Microcompact clears old tool results **without re-sending** them
- Cached microcompact emits `cache_edits` for API without local mutation
- `applyToolResultBudget` caps individual results before they enter context
- Snip removes entire message segments cheaply

### Background Processing
- `startSkillDiscoveryPrefetch` — prefetch skill data each iteration
- `executePostSamplingHooks` — fire-and-forget after assistant messages
- `generateToolUseSummary` — async summary generation overlaps with next model call
- Task summary module for background sessions

### Concurrency Controls
- `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY` (default 10)
- Configurable per deployment
- Prevents overwhelming the filesystem/process with parallel tools

### Token Warning System
- `calculateTokenWarningState` before API calls
- `isAtBlockingLimit` → don't even try the API call
- Prevents wasted API calls on oversized contexts

---

## What Sysflow AI Has (Gaps)

### Phase-Based SSE, Not Token Streaming
- `POST /agent/stream` sends SSE events: `phase` → `result` or `error`
- Each turn is one full model response — no incremental tokens
- User sees "thinking..." then the full response
- `callServerStream` reads SSE, invokes `onPhase`, returns final JSON
- This is **event notification**, not streaming

### 3 HTTP Round-Trips Per Turn
The inner loop for each tool execution:
1. CLI → Server: `POST /agent/run` (user_message or tool_result)
2. Server → Model API: call model
3. Model API → Server: response
4. Server → CLI: response
5. CLI: execute tool locally
6. CLI → Server: `POST /agent/run` (tool_result)
7. Server → Model API: call model with result
8. ... repeat

Each turn requires **at minimum 2 HTTP hops** (CLI→Server, Server→CLI), plus the model API call. For a 20-turn task, that's 40+ HTTP round-trips just for orchestration.

### No Streaming Tool Execution
- Tools execute only after the full model response arrives
- No overlap between model generation and tool execution
- Each turn's latency = model generation time + tool execution time (sequential)
- For tasks with many tool calls, this adds significant wall-clock time

### No Prompt Cache Optimization
- Entire system prompt sent every request
- No cache boundary markers
- No tool sorting for cache stability
- Every turn pays full prompt processing cost

### No Pre-API Token Check
- No `calculateTokenWarningState` equivalent
- Can waste an API call on a context that's too large
- Only discovers the problem when the API returns an error

### No Background Processing
- No prefetching of any kind
- No fire-and-forget hooks
- No overlapped summary generation
- Everything is strictly sequential

### No Concurrency Controls
- `executeToolsBatch` runs all non-command tools in parallel with no limit
- 20 file writes could all run simultaneously
- No configurable concurrency cap

---

## What to Implement

### Priority 1: Token-Level Streaming
```typescript
// Use Gemini's streaming API
async function* streamModelResponse(
  model: GenerativeModel,
  messages: Content[],
  systemPrompt: string
): AsyncGenerator<StreamChunk> {
  const result = await model.generateContentStream({
    contents: messages,
    systemInstruction: systemPrompt,
  });
  
  for await (const chunk of result.stream) {
    const text = chunk.text();
    if (text) {
      yield { type: 'text_delta', text };
    }
    
    // Detect tool use blocks as they complete
    const toolUse = extractCompletedToolUse(chunk);
    if (toolUse) {
      yield { type: 'tool_use', block: toolUse };
    }
  }
  
  // Final usage stats
  const response = await result.response;
  yield { type: 'usage', usage: response.usageMetadata };
}
```

### Priority 2: Eliminate HTTP Round-Trips
Move to an in-process architecture or at minimum reduce round-trips:

**Option A: In-Process (Recommended)**
- Bundle server logic into the CLI
- Tool execution and model calling in the same process
- No HTTP overhead in the inner loop
- Keep the server only for auth, billing, and usage tracking

**Option B: WebSocket**
- Replace HTTP request-response with a persistent WebSocket
- Server pushes events as they happen
- CLI sends tool results over the same connection
- Reduces connection overhead

**Option C: Batch Turn Protocol**
- CLI sends tool results and immediately gets next model response in single HTTP call
- Combine `tool_result` POST + model call + response into one round-trip

### Priority 3: Streaming Tool Execution
```typescript
class StreamingToolExecutor {
  private queue: TrackedTool[] = [];
  private executing: Map<string, Promise<ToolResult>> = new Map();
  private completed: ToolResult[] = [];
  private maxConcurrency = 10;
  
  addTool(block: ToolUseBlock): void {
    const tool = findToolByName(block.name);
    if (!tool) {
      this.completed.push(createErrorResult(block, 'Unknown tool'));
      return;
    }
    
    const isSafe = tool.isConcurrencySafe?.(block.input) ?? false;
    this.queue.push({ block, tool, isSafe });
    this.processQueue();
  }
  
  private processQueue(): void {
    while (this.queue.length > 0) {
      const next = this.queue[0];
      
      if (!this.canExecute(next)) break;
      
      this.queue.shift();
      const promise = this.executeTool(next);
      this.executing.set(next.block.id, promise);
    }
  }
  
  private canExecute(tool: TrackedTool): boolean {
    if (this.executing.size >= this.maxConcurrency) return false;
    if (!tool.isSafe && this.executing.size > 0) return false;
    if (!tool.isSafe) return true;
    // Safe tools can run alongside other safe tools
    return [...this.executing.values()].every(/* check all are safe */);
  }
  
  *getCompletedResults(): Generator<ToolResult> {
    while (this.completed.length > 0) {
      yield this.completed.shift()!;
    }
  }
  
  async getRemainingResults(): Promise<ToolResult[]> {
    await Promise.all(this.executing.values());
    return [...this.completed];
  }
}
```

### Priority 4: Concurrency Limiter
```typescript
const DEFAULT_MAX_CONCURRENCY = 10;

async function runWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  maxConcurrency: number = DEFAULT_MAX_CONCURRENCY
): Promise<T[]> {
  const results: T[] = [];
  const executing: Promise<void>[] = [];
  
  for (const task of tasks) {
    const p = task().then(r => { results.push(r); });
    executing.push(p);
    
    if (executing.length >= maxConcurrency) {
      await Promise.race(executing);
      // Remove settled promises
      for (let i = executing.length - 1; i >= 0; i--) {
        const settled = await Promise.race([
          executing[i].then(() => true),
          Promise.resolve(false)
        ]);
        if (settled) executing.splice(i, 1);
      }
    }
  }
  
  await Promise.all(executing);
  return results;
}
```

### Priority 5: Pre-API Token Guard
```typescript
function shouldCallAPI(messages: Message[], model: string): {
  proceed: boolean;
  tokenEstimate: number;
  warningLevel: 'none' | 'warning' | 'blocking';
  message?: string;
} {
  const tokens = estimateTokenCount(messages);
  const limit = MODEL_CONTEXT_WINDOWS[model];
  const warningThreshold = limit * 0.85;
  const blockingThreshold = limit * 0.95;
  
  if (tokens >= blockingThreshold) {
    return {
      proceed: false,
      tokenEstimate: tokens,
      warningLevel: 'blocking',
      message: `Context (${tokens} tokens) exceeds blocking limit (${blockingThreshold}). Compact first.`,
    };
  }
  
  if (tokens >= warningThreshold) {
    return {
      proceed: true,
      tokenEstimate: tokens,
      warningLevel: 'warning',
      message: `Context is ${Math.round(tokens/limit * 100)}% of limit. Consider compacting soon.`,
    };
  }
  
  return { proceed: true, tokenEstimate: tokens, warningLevel: 'none' };
}
```
