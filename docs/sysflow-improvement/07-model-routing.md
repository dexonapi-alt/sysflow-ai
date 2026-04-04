# 07 — Model Routing & Retry Strategy

## What Claude Code Has

### Multi-Level Model Selection
1. **User override** — `/model` command, `--model` flag, `ANTHROPIC_MODEL` env, settings
2. **Model allowlist** — `isModelAllowed` filters disallowed models
3. **Default by subscription tier** — Max/Team Premium → Opus; others → Sonnet
4. **Aliases** — `opus`, `sonnet`, `haiku`, `opusplan`, `best`, `[1m]` suffix for extended context
5. **`parseUserSpecifiedModel`** — resolves aliases to actual model IDs, handles legacy remap

### Runtime Model Switching (`getRuntimeMainLoopModel`)
- **Plan mode + opusplan**: switches to Opus when in plan mode, Sonnet otherwise
- **Haiku + plan mode**: upgrades to Sonnet for plan mode
- **200k+ token threshold**: can downgrade model when context exceeds 200k tokens
- This means the model can change **mid-conversation** based on context size and mode

### Fallback During Streaming
- `FallbackTriggeredError` after 3 consecutive 529 errors → switch to fallback model
- Fallback happens **within the same turn**, not after failure
- Orphaned assistant messages are tombstoned
- Streaming executor discarded and recreated
- User sees a warning but the conversation continues

### 529-Specific Retry Logic
- Separate counter for consecutive 529 errors
- `MAX_529_RETRIES = 3` before triggering fallback
- `FOREGROUND_529_RETRY_SOURCES` whitelist — background jobs can't retry 529s
- 529 vs 429 distinction: 529 = server overloaded, 429 = rate limit

### Persistent Retry for Background Agents
- `UNATTENDED_RETRY` + env flag enables unbounded retries
- `PERSISTENT_MAX_BACKOFF_MS` cap on backoff
- `PERSISTENT_RESET_CAP_MS` resets backoff after success
- Heartbeat interval during long retries
- For transient capacity errors (429/529) only

### Fast Mode with Graceful Degradation
- Fast mode (cheaper/faster model) with overrage detection
- Short retry-after → sleep and retry
- Long retry-after → cooldown fast mode, fall back to normal
- `triggerFastModeCooldown` / `handleFastModeOverageRejection`

### Auth Refresh on Retry
- 401 → OAuth token refresh → retry with fresh credentials
- AWS Bedrock credential error → refresh → retry
- GCP Vertex credential error → refresh → retry

---

## What Sysflow AI Has (Gaps)

### Static Model Selection
- Model chosen at request time by the CLI user
- `MODELS` array in `sysbase.ts` with `openrouter-auto`, `gemini-flash` visible
- Server `adapter.ts` registers more IDs but selection is client-driven
- No runtime model switching based on context or mode
- No plan mode model routing

### Simple Fallback Chain (Rate Limit Only)
- `MODEL_FALLBACK_CHAINS` maps primary → fallback list
- Only triggers on `rate_limited` status — not on 529, not on streaming errors
- `callWithRetry`: up to 4 attempts, only on rate limit
- No 529-specific handling
- No fallback during streaming (can't switch mid-turn)

### Provider-Level Rate Limit State
- `getRateLimitState` / `recordRateLimit` per provider name (not per model)
- Two models on the same provider share rate limit state
- Backoff is exponential but resets are naive

### No Persistent Retry
- No unattended/background retry mode
- Long-running tasks that hit rate limits just fail after 3-4 retries
- CLI has a usage-limit retry loop but it's separate from model retry

### No Auth Refresh
- No OAuth token refresh on 401
- No cloud credential refresh
- API keys are static — if they expire, the system fails

### No Fast Mode
- No cheaper/faster model option with graceful fallback
- Every request uses the same model at the same cost
- No overrage detection or cooldown

### Inconsistent Error Handling Across Providers
- Gemini: catches specific API errors (invalid key, 429, quota)
- OpenRouter: different error patterns
- Claude: yet another pattern
- No unified error taxonomy across providers

---

## What to Implement

### Priority 1: Unified Error Taxonomy
```typescript
enum ProviderErrorType {
  RATE_LIMITED = 'rate_limited',        // 429
  OVERLOADED = 'overloaded',            // 529, 503
  AUTH_EXPIRED = 'auth_expired',        // 401
  INVALID_KEY = 'invalid_key',          // 401 + specific message
  PROMPT_TOO_LONG = 'prompt_too_long',  // 413, 400 with context overflow
  MAX_TOKENS = 'max_tokens',            // response truncated
  CONTENT_FILTER = 'content_filter',    // safety filter triggered
  CONNECTION = 'connection',            // ECONNRESET, EPIPE, ETIMEDOUT
  UNKNOWN = 'unknown',
}

function classifyProviderError(error: Error, provider: string): ProviderErrorType {
  const status = error.status || error.statusCode;
  
  if (status === 429) return ProviderErrorType.RATE_LIMITED;
  if (status === 529 || status === 503) return ProviderErrorType.OVERLOADED;
  if (status === 401) {
    if (error.message?.includes('invalid')) return ProviderErrorType.INVALID_KEY;
    return ProviderErrorType.AUTH_EXPIRED;
  }
  if (status === 413) return ProviderErrorType.PROMPT_TOO_LONG;
  if (error.code === 'ECONNRESET' || error.code === 'EPIPE') return ProviderErrorType.CONNECTION;
  return ProviderErrorType.UNKNOWN;
}
```

### Priority 2: Robust Retry per Error Type
```typescript
const RETRY_CONFIG: Record<ProviderErrorType, RetryPolicy> = {
  [ProviderErrorType.RATE_LIMITED]: { maxRetries: 10, backoff: 'exponential', maxDelay: 60_000 },
  [ProviderErrorType.OVERLOADED]:   { maxRetries: 5, backoff: 'exponential', maxDelay: 30_000, triggerFallbackAfter: 3 },
  [ProviderErrorType.AUTH_EXPIRED]: { maxRetries: 2, backoff: 'none', action: 'refresh_auth' },
  [ProviderErrorType.CONNECTION]:   { maxRetries: 5, backoff: 'exponential', maxDelay: 16_000, freshClient: true },
  [ProviderErrorType.PROMPT_TOO_LONG]: { maxRetries: 1, action: 'compact_and_retry' },
  [ProviderErrorType.MAX_TOKENS]:   { maxRetries: 3, action: 'escalate_or_continue' },
  [ProviderErrorType.CONTENT_FILTER]: { maxRetries: 0 },
  [ProviderErrorType.INVALID_KEY]:  { maxRetries: 0 },
  [ProviderErrorType.UNKNOWN]:      { maxRetries: 3, backoff: 'exponential', maxDelay: 16_000 },
};
```

### Priority 3: Runtime Model Routing
```typescript
interface ModelRoutingConfig {
  defaultModel: string;
  planModeModel?: string;        // Upgrade for planning tasks
  largeContextModel?: string;    // For >200k tokens
  fallbackModel?: string;        // On overload/failure
  fastModel?: string;            // For simple/cheap operations
}

function resolveModel(config: ModelRoutingConfig, context: {
  mode: 'normal' | 'plan';
  estimatedTokens: number;
  retryCount: number;
}): string {
  // Plan mode upgrade
  if (context.mode === 'plan' && config.planModeModel) {
    return config.planModeModel;
  }
  
  // Large context downgrade
  if (context.estimatedTokens > 200_000 && config.largeContextModel) {
    return config.largeContextModel;
  }
  
  // Fallback after retries
  if (context.retryCount >= 3 && config.fallbackModel) {
    return config.fallbackModel;
  }
  
  return config.defaultModel;
}
```

### Priority 4: Per-Model Rate Limit State
```typescript
// Track rate limits per model, not per provider
const rateLimitState = new Map<string, {
  hitCount: number;
  backoffMs: number;
  lastHitAt: number;
  resetAt?: number;
}>();

function recordRateLimit(modelId: string, retryAfterMs?: number): void {
  const state = rateLimitState.get(modelId) ?? { hitCount: 0, backoffMs: 1000, lastHitAt: 0 };
  state.hitCount++;
  state.lastHitAt = Date.now();
  state.backoffMs = Math.min(state.backoffMs * 2, 60_000);
  if (retryAfterMs) state.resetAt = Date.now() + retryAfterMs;
  rateLimitState.set(modelId, state);
}
```

### Priority 5: Fast Mode
```typescript
// Allow users to opt into a cheaper/faster model for simple tasks
const FAST_MODE_MODELS: Record<string, string> = {
  'gemini-pro': 'gemini-flash',
  'claude-sonnet': 'claude-haiku',
};

function getFastModeModel(currentModel: string): string | null {
  return FAST_MODE_MODELS[currentModel] ?? null;
}
```
