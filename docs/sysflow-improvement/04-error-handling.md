# 04 — Error Handling & Recovery

## What Claude Code Has

### Layered Retry System (`withRetry.ts`)
- **Default 10 retries** (configurable via `CLAUDE_CODE_MAX_RETRIES`)
- Exponential backoff: `BASE_DELAY_MS * 2^(attempt-1)` capped at 32s + jitter
- **529-specific handling**: separate counter, max 3 consecutive 529s before fallback
- **Fast mode + 429/529**: overage header detection, short retry-after → sleep, long → cooldown
- **Persistent retry mode** (`UNATTENDED_RETRY`): unbounded retries with backoff cap for unattended/background agents
- **OAuth refresh**: on 401, refresh credentials and retry
- **Bedrock/Vertex auth**: credential error → refresh → retry
- **Stale connection detection**: ECONNRESET/EPIPE → fresh client
- **`CannotRetryError`**: explicit "give up" signal (not retriable)
- **`FallbackTriggeredError`**: triggers model fallback in the loop
- Heartbeat interval during long retries for persistent mode

### Max Output Token Recovery
- When model hits `max_output_tokens`, **up to 3 recovery attempts**
- First: escalate to `ESCALATED_MAX_TOKENS`
- Then: meta user message asking model to continue from where it left off
- `max_output_tokens_recovery` continue reason in the loop
- Withheld from UI until recovery decision made

### Context Overflow Recovery
- `parseMaxTokensContextOverflowError` detects API 413 errors
- Adjusts `retryContext.maxTokensOverride` and retries
- If reactive compact is available, triggers compaction before retry
- Context collapse drain as intermediate step
- Cascading fallback: collapse → reactive compact → prompt_too_long terminal

### Streaming Error Handling
- Errors during streaming are caught per-chunk
- `FallbackTriggeredError` → switch model, clean up orphans, continue
- Image errors → `image_error` terminal
- Unknown errors → synthetic tool_result blocks for orphaned tool_use, then API error message
- `isWithheldMaxOutputTokens` — don't show error until recovery path is chosen

### Tool Error Classification
- `classifyToolError` in `toolExecution.ts`
- Categories: Zod validation, MCP auth, timeout, permission, filesystem, unknown
- Each category has a specific recovery path
- MCP auth errors → set app state to `needs-auth`
- Zod errors include schema hint for the model

### Abort Handling
- `AbortController` integration throughout
- Abort during streaming → drain remaining results, yield missing tool_results
- Abort during tools → complete current tool, stop queue
- Chicago MCP cleanup on abort
- Different abort reasons: `interrupt`, `sibling_error`, `discard`

### Error-Aware Continue/Terminal Decisions
- `model_error` vs `prompt_too_long` vs `image_error` vs `blocking_limit` — each has distinct handling
- Recovery attempts tracked to prevent infinite loops
- `MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3` hard cap

---

## What Sysflow AI Has (Gaps)

### Minimal Retry Logic
- **Only 3 retries** (base-provider `callWithRetry`)
- Backoff only on rate limit, not other transient errors
- HTTP client (`server.ts`) has 3 retries with exponential backoff, but only for client-server communication
- No persistent retry mode for long-running tasks
- No retry on connection errors (ECONNRESET, EPIPE)
- No OAuth/credential refresh

### No Max Output Token Recovery
- If the model hits output token limit, the response is truncated
- No escalation to higher token limits
- No "continue from where you left off" mechanism
- Truncated responses are parsed as-is, often producing broken JSON
- `parseJsonResponse` has a truncation recovery that force-creates a `needs_tool` with `list_directory` — a bandaid, not a real solution

### No Context Overflow Recovery
- No detection of 413/prompt-too-long errors (Gemini returns 400, not 413)
- No reactive compaction
- No context collapse
- When context is too large, the model simply fails or produces garbage
- The only "recovery" is the fallback chain to a different model/provider

### Fragile JSON Parsing as Error Recovery
- `parseJsonResponse` in `base-provider.ts` IS the error recovery for malformed model output
- Tries: full parse → fenced JSON → first `{...}` → truncation recovery → raw text as completed
- This hides errors instead of recovering from them
- The model doesn't know its response was malformed — it never gets corrective feedback

### Shallow Tool Error Handling
- `enrichSingleError` adds hints for ENOENT, permissions, etc. — but these are **string pattern matches on error text**
- No structured error classification
- `recoverFromCommandError` in CLI offers web search or user prompt — decent but CLI-only
- `MAX_CONSECUTIVE_ERRORS = 3` in agent loop → abort (no recovery, just give up)
- No abort handling — process exit is the only way to stop

### No Streaming Error Handling
- Sysflow uses SSE for phase updates, not real streaming
- No mid-stream error recovery
- No orphaned message cleanup
- No fallback model trigger during streaming

### Error-Fix System is Heuristic-Heavy
- `detectErrorContext` / `detectErrorForSearch` in `user-message.ts`
- `error-autofix.ts` parses import errors and forces search/read pipelines
- These are good ideas but implemented as regex-based heuristics
- No structured error taxonomy
- Pending error queue is a good pattern but only handles one error type well (import errors)

---

## What to Implement

### Priority 1: Robust Retry with Exponential Backoff
```typescript
interface RetryConfig {
  maxRetries: number;         // Default 10
  baseDelayMs: number;        // Default 1000
  maxDelayMs: number;         // Default 32000
  retryOn: (error: Error) => boolean;
  onRetry?: (attempt: number, error: Error, delayMs: number) => void;
}

async function* withRetry<T>(
  fn: () => AsyncGenerator<T>,
  config: RetryConfig
): AsyncGenerator<T | RetryEvent> {
  let attempt = 0;
  
  while (attempt <= config.maxRetries) {
    try {
      yield* fn();
      return;
    } catch (error) {
      attempt++;
      
      if (!config.retryOn(error) || attempt > config.maxRetries) {
        throw new CannotRetryError(error, attempt);
      }
      
      const delay = Math.min(
        config.baseDelayMs * Math.pow(2, attempt - 1) + Math.random() * 1000,
        config.maxDelayMs
      );
      
      yield { type: 'retry', attempt, delay, error: error.message };
      config.onRetry?.(attempt, error, delay);
      await sleep(delay);
    }
  }
}

function shouldRetry(error: Error): boolean {
  if (error instanceof CannotRetryError) return false;
  if (isRateLimitError(error)) return true;
  if (isTransientError(error)) return true;     // 500, 502, 503, 529
  if (isConnectionError(error)) return true;    // ECONNRESET, EPIPE, ETIMEDOUT
  if (isAuthRefreshable(error)) return true;    // 401 with refresh token
  return false;
}
```

### Priority 2: Max Output Token Recovery
```typescript
const MAX_OUTPUT_TOKEN_RECOVERY_LIMIT = 3;

async function handleMaxOutputTokens(
  state: LoopState,
  recoveryCount: number
): Promise<RecoveryAction> {
  if (recoveryCount >= MAX_OUTPUT_TOKEN_RECOVERY_LIMIT) {
    return { action: 'terminal', reason: 'max_output_tokens_exhausted' };
  }
  
  if (recoveryCount === 0 && !state.maxTokensOverride) {
    // First attempt: escalate token limit
    return {
      action: 'continue',
      reason: 'max_output_tokens_escalate',
      maxTokensOverride: ESCALATED_MAX_TOKENS,
    };
  }
  
  // Subsequent: ask model to continue
  return {
    action: 'continue',
    reason: 'max_output_tokens_recovery',
    injectedMessage: {
      role: 'user',
      content: 'Your previous response was cut off due to length limits. Please continue exactly where you left off.',
    },
  };
}
```

### Priority 3: Structured Error Classification
```typescript
enum ToolErrorCategory {
  VALIDATION = 'validation',
  PERMISSION = 'permission',
  FILE_NOT_FOUND = 'file_not_found',
  FILE_TOO_LARGE = 'file_too_large',
  TIMEOUT = 'timeout',
  COMMAND_FAILED = 'command_failed',
  NETWORK = 'network',
  AUTH = 'auth',
  UNKNOWN = 'unknown',
}

function classifyToolError(error: Error, tool: string): ToolErrorCategory {
  if (error instanceof ZodError) return ToolErrorCategory.VALIDATION;
  if (error.code === 'ENOENT') return ToolErrorCategory.FILE_NOT_FOUND;
  if (error.code === 'EACCES') return ToolErrorCategory.PERMISSION;
  if (error.code === 'ETIMEDOUT') return ToolErrorCategory.TIMEOUT;
  // ... more classifications
  return ToolErrorCategory.UNKNOWN;
}

function getRecoveryHint(category: ToolErrorCategory, tool: string): string {
  switch (category) {
    case ToolErrorCategory.FILE_NOT_FOUND:
      return 'File does not exist. Use search_files or list_directory to find the correct path.';
    case ToolErrorCategory.VALIDATION:
      return 'Invalid arguments. Check the tool schema and try again.';
    case ToolErrorCategory.PERMISSION:
      return 'Permission denied. Check file permissions or try a different approach.';
    // ...
  }
}
```

### Priority 4: Context Overflow Recovery
```typescript
async function handleContextOverflow(
  state: LoopState,
  error: APIError
): Promise<RecoveryAction> {
  // Step 1: Try microcompact
  const microcompacted = microcompact(state.messages);
  if (estimateTokenCount(microcompacted) < getModelLimit(state.model)) {
    return { action: 'continue', reason: 'microcompact_recovery', messages: microcompacted };
  }
  
  // Step 2: Try autocompact
  const compacted = await autocompactIfNeeded(state.messages, state.model, state.callModel);
  if (compacted) {
    return { action: 'continue', reason: 'compact_recovery', messages: compacted.messages };
  }
  
  // Step 3: Terminal
  return { action: 'terminal', reason: 'prompt_too_long' };
}
```

### Priority 5: Stop Hiding Errors
Instead of silently converting malformed JSON to `completed` or `list_directory`:
```typescript
function parseModelResponse(text: string): ParseResult {
  // Try clean JSON parse first
  const cleanParse = tryParseJSON(text);
  if (cleanParse.success) return cleanParse;
  
  // Try fenced JSON
  const fencedParse = tryParseFencedJSON(text);
  if (fencedParse.success) return fencedParse;
  
  // INSTEAD OF silently recovering:
  // Return a structured error that the model sees
  return {
    success: false,
    error: 'malformed_response',
    recovery: {
      kind: 'needs_tool',
      tool: '_response_error',
      content: `Your previous response was not valid JSON. Raw text: "${text.slice(0, 500)}...". Please respond with valid JSON matching the required schema.`,
    }
  };
}
```
