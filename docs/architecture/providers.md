# AI Provider System

> Location: `server/src/providers/`
> Pattern: OOP with abstract base class

## Class Hierarchy

```
BaseProvider (abstract)
├── GeminiProvider        # Google Gemini models
├── OpenRouterProvider    # OpenRouter (Llama, Mistral, etc.)
├── ClaudeSonnetProvider  # Anthropic Claude Sonnet
├── ClaudeOpusProvider    # Anthropic Claude Opus
└── SweProvider           # Mock provider for testing
```

## Model Registry

| Model Key | Actual Model | Provider | Visible in CLI |
|-----------|-------------|----------|----------------|
| `gemini-flash` | `gemini-2.5-flash` | Gemini | Yes |
| `gemini-pro` | `gemini-2.5-pro` | Gemini | No |
| `openrouter-auto` | `openrouter/auto` | OpenRouter | Yes |
| `llama-70b` | `meta-llama/llama-3.3-70b-instruct:free` | OpenRouter | No |
| `mistral-small` | `mistralai/mistral-small-3.1-24b-instruct:free` | OpenRouter | No |
| `gemini-flash-or` | `google/gemini-2.0-flash-exp:free` | OpenRouter | No |
| `claude-sonnet` | `claude-sonnet-4-20250514` | Anthropic | No (MOCKED — returns fake responses) |
| `claude-opus` | `claude-opus-4-20250514` | Anthropic | No (MOCKED — returns fake responses) |

## Provider Selection

`adapter.ts` contains `getProvider(model)` — maps model key to provider instance.

## Normalized Response Format

All providers return the same shape:

```typescript
{
  kind: "needs_tool" | "completed" | "failed" | "waiting_for_user",
  reasoning?: string,
  tool?: string,
  args?: Record<string, unknown>,
  content?: string,
  error?: string,
  usage: { inputTokens: number, outputTokens: number, generationData?: any }
}
```

## Provider Payload (Input)

```typescript
{
  model: string,
  runId: string,
  userMessage: string,
  directoryTree: string,      // Project file structure
  context: {
    sessionHistory,           // Last 20 prompts/outcomes
    projectMemory,            // In-memory store
    continueContext            // Resume context
  },
  toolResult?: any,           // Previous tool result
  task?: any                  // Task metadata
}
```

## Provider Status

| Provider | Status | Notes |
|----------|--------|-------|
| GeminiProvider | **Functional** | Structured JSON output, 8192 max output tokens |
| OpenRouterProvider | **Functional** | Retry with 2x backoff, 120s timeout, 2 retries |
| ClaudeSonnetProvider | **MOCKED** | Returns hardcoded responses, TODO: real API |
| ClaudeOpusProvider | **MOCKED** | Returns hardcoded responses, TODO: real API |
| SweProvider | **Mock/Demo** | Deterministic 20+ step auth system implementation |

## Adding a New Provider

1. Create `server/src/providers/your-provider.ts`
2. Extend `BaseProvider`
3. Implement `chat()` method
4. Register in `adapter.ts` via the provider registry
5. Add model key to CLI model list if it should be user-visible (`cli-client/src/lib/sysbase.ts`)
