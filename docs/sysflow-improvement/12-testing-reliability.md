# 12 — Testing & Reliability

## What Claude Code Has

### Biome for Linting & Formatting
- `package.json` includes Biome for `lint` and `format` scripts
- `tsc --noEmit` for type checking
- Code quality enforced at build time
- Consistent formatting across the codebase

### Session Manager Tests
- `__tests__/session-manager.test.ts` — tests for session lifecycle
- `__tests__/auth.test.ts` — tests for authentication flow
- Tests exist for critical infrastructure components

### Feature Flag System (GrowthBook/Statsig)
- `feature('...')` from `bun:bundle` — compile-time flags
- Dead code elimination when flags are false
- Progressive rollout of new features
- A/B testing for different strategies (e.g., tool result size caps)
- `GrowthBook overrides` mentioned for tool result budgets
- This enables **safe experimentation** — try new approaches without breaking everything

### Circuit Breakers
- Autocompact has a circuit breaker: 3 consecutive failures → stop trying
- Prevents cascading failures when compaction is broken
- Self-healing: resets after success

### Abort System
- `AbortController` throughout the codebase
- Clean cancellation of streaming, tool execution, and sub-tasks
- Different abort reasons tracked (`interrupt`, `sibling_error`, `discard`)
- Resources cleaned up on abort (MCP, streaming executor, pending promises)

### Structured Error Types
- `CannotRetryError` — explicit "give up" signal
- `FallbackTriggeredError` — triggers model switch
- `APIUserAbortError` — user-initiated cancellation
- `ImageSizeError` / `ImageResizeError` — specific image processing failures
- Error types drive control flow, not string matching

### Telemetry & Analytics
- OTel spans: `startToolSpan` / `endToolSpan`
- `classifyToolError` for categorization
- `decisionReasonToOTelSource` for permission tracking
- `tengu_compact` analytics for compaction events
- Tool use summary generation for analytics

### Tool Validation Pipeline
- Zod schema validation (structural)
- `validateInput` hook (semantic)
- `checkPermissions` (authorization)
- `backfillObservableInput` (transcript stability)
- Each layer catches different classes of errors

### Hooks for Extension
- Pre/post tool use hooks — extensible behavior
- Post-sampling hooks — after model response
- Stop hooks — before completion
- Hooks can prevent execution, modify input/output, inject context
- Makes the system testable and extensible

### Multiple Recovery Paths
For any failure, there are usually 2-3 recovery options:
- Model error → retry with backoff → fallback model → terminal
- Context overflow → microcompact → autocompact → reactive compact → terminal
- Max output tokens → escalate → recovery message → terminal
- Tool error → structured error to model → model self-corrects → consecutive error limit

---

## What Sysflow AI Has (Gaps)

### No Tests
- No `jest`, `vitest`, or `mocha` scripts in `server/package.json` or `cli-client/package.json`
- Only `typecheck`, `build`, `start`, `dev` scripts
- `SweProvider` is a deterministic mock — acts as integration test substitute but is not a real test
- No unit tests for any module
- No integration tests
- No end-to-end tests

### No Feature Flags
- No compile-time or runtime feature flags
- All features are always on
- No progressive rollout capability
- No A/B testing
- No way to disable a broken feature without a code deploy
- Changes are all-or-nothing

### No Circuit Breakers
- If a subsystem fails repeatedly, it keeps failing
- No consecutive failure tracking (except `MAX_CONSECUTIVE_ERRORS = 3` in agent loop which just aborts)
- No self-healing after transient failures

### No Abort System
- No `AbortController` usage
- `Ctrl+C` kills the process — no clean cleanup
- Long-running tool calls can't be cancelled
- No resource cleanup on interruption

### String-Based Error Handling
- Errors are identified by string matching, not typed errors
- `enrichSingleError` pattern-matches error text (ENOENT, permissions, etc.)
- `recoverFromCommandError` uses string patterns
- No error taxonomy — similar errors handled differently in different places

### No Telemetry
- No OTel integration
- No tool execution spans
- No analytics for compaction, retry, or error patterns
- No way to know which parts of the system are failing most
- No data-driven improvement capability

### Minimal Validation Pipeline
- `parseArgsRobust` tries to salvage any JSON — too permissive
- No Zod schemas
- No `validateInput` hooks
- No `checkPermissions` hooks
- Invalid tool calls silently converted to `list_directory`

### Single Recovery Path
Most failures have one recovery option:
- Rate limit → retry 3 times → fail
- Model error → fail
- Tool error → show error → retry up to 3 times → abort
- Context overflow → fail (no compaction)
- Malformed JSON → salvage heuristics → may produce wrong result

---

## What to Implement

### Priority 1: Testing Infrastructure
```json
// package.json additions
{
  "scripts": {
    "test": "vitest",
    "test:unit": "vitest run --reporter=verbose",
    "test:integration": "vitest run --config vitest.integration.config.ts",
    "test:coverage": "vitest run --coverage"
  },
  "devDependencies": {
    "vitest": "latest",
    "@vitest/coverage-v8": "latest"
  }
}
```

Critical modules to test first:
1. `parseArgsRobust` — the most fragile function
2. `parseJsonResponse` — response parsing correctness
3. `editFileTool` — all edit modes
4. `completion-guard` — validation logic
5. `action-planner` — intercept decisions
6. `context-manager` — context building
7. `task-pipeline` — pipeline state machine

### Priority 2: Feature Flag System
```typescript
interface FeatureFlags {
  streamingToolExecution: boolean;
  autocompact: boolean;
  microcompact: boolean;
  reactiveCompact: boolean;
  planMode: boolean;
  subAgents: boolean;
  permissionSystem: boolean;
  ripgrepSearch: boolean;
  webFetch: boolean;
  promptCaching: boolean;
}

// Runtime flags (can change without deploy)
const flags: FeatureFlags = {
  streamingToolExecution: process.env.FF_STREAMING_TOOLS === 'true',
  autocompact: process.env.FF_AUTOCOMPACT !== 'false', // default on
  microcompact: process.env.FF_MICROCOMPACT !== 'false',
  // ...
};

// Usage
if (flags.autocompact) {
  messages = await autocompactIfNeeded(messages, model, callModel);
}
```

### Priority 3: Circuit Breakers
```typescript
class CircuitBreaker {
  private failures = 0;
  private lastFailure = 0;
  private state: 'closed' | 'open' | 'half-open' = 'closed';
  
  constructor(
    private maxFailures: number = 3,
    private resetTimeMs: number = 60_000
  ) {}
  
  canExecute(): boolean {
    if (this.state === 'closed') return true;
    if (this.state === 'open') {
      if (Date.now() - this.lastFailure > this.resetTimeMs) {
        this.state = 'half-open';
        return true;
      }
      return false;
    }
    return true; // half-open: allow one attempt
  }
  
  recordSuccess(): void {
    this.failures = 0;
    this.state = 'closed';
  }
  
  recordFailure(): void {
    this.failures++;
    this.lastFailure = Date.now();
    if (this.failures >= this.maxFailures) {
      this.state = 'open';
    }
  }
}

// Usage
const compactBreaker = new CircuitBreaker(3, 60_000);

async function autocompactIfNeeded(messages: Message[]): Promise<CompactResult | null> {
  if (!compactBreaker.canExecute()) return null;
  
  try {
    const result = await doCompaction(messages);
    compactBreaker.recordSuccess();
    return result;
  } catch (error) {
    compactBreaker.recordFailure();
    throw error;
  }
}
```

### Priority 4: Typed Error System
```typescript
class SysflowError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly recoverable: boolean,
    public readonly context?: Record<string, unknown>
  ) {
    super(message);
  }
}

class ToolValidationError extends SysflowError {
  constructor(tool: string, field: string, message: string) {
    super(message, 'TOOL_VALIDATION', true, { tool, field });
  }
}

class ContextOverflowError extends SysflowError {
  constructor(tokenCount: number, limit: number) {
    super(`Context (${tokenCount} tokens) exceeds limit (${limit})`, 'CONTEXT_OVERFLOW', true, { tokenCount, limit });
  }
}

class ModelResponseError extends SysflowError {
  constructor(message: string, public readonly rawResponse: string) {
    super(message, 'MODEL_RESPONSE', true, { rawResponse: rawResponse.slice(0, 500) });
  }
}

// ... RateLimitError, AuthError, ProviderError, etc.
```

### Priority 5: Abort System
```typescript
class AgentAbortController {
  private controller = new AbortController();
  private cleanupFns: (() => void)[] = [];
  
  get signal(): AbortSignal { return this.controller.signal; }
  
  abort(reason: string): void {
    this.controller.abort(reason);
    for (const fn of this.cleanupFns) {
      try { fn(); } catch {}
    }
  }
  
  onAbort(fn: () => void): void {
    this.cleanupFns.push(fn);
    this.signal.addEventListener('abort', fn);
  }
  
  createChild(): AgentAbortController {
    const child = new AgentAbortController();
    this.onAbort(() => child.abort('parent_aborted'));
    return child;
  }
}
```

### Priority 6: Basic Telemetry
```typescript
interface ToolMetrics {
  toolName: string;
  duration: number;
  success: boolean;
  errorType?: string;
  inputSize: number;
  outputSize: number;
}

class MetricsCollector {
  private metrics: ToolMetrics[] = [];
  
  record(metric: ToolMetrics): void {
    this.metrics.push(metric);
  }
  
  getSummary(): {
    totalCalls: number;
    successRate: number;
    avgDuration: number;
    errorsByType: Record<string, number>;
    slowestTools: { tool: string; avgMs: number }[];
  } {
    // Aggregate metrics
  }
}
```
