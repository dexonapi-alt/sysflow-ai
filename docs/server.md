# Server Architecture

The Sysflow server is a Fastify REST API that orchestrates AI model calls, manages user sessions, and handles billing.

## Directory Structure

```
server/src/
├── index.js              # Entry point — Fastify setup, plugin registration
├── services/             # Core business logic
│   ├── context.js        # Loads project context (memories, fixes, sysbase)
│   └── task.js           # Creates task objects with steps for the AI
├── routes/               # HTTP route handlers
│   ├── agent.js          # POST /agent/run — main AI orchestration endpoint
│   ├── auth.js           # POST /auth/register, /auth/login, JWT helpers
│   ├── chats.js          # CRUD for /chats (list, create, delete)
│   └── billing.js        # Stripe checkout, webhooks, usage, plans
├── handlers/             # Request orchestration (called by routes)
│   ├── user-message.js   # Handles first user prompt → creates run, calls AI
│   └── tool-result.js    # Handles tool results → calls AI for next action
├── providers/            # AI model adapters
│   ├── adapter.js        # Routes to correct provider by model ID
│   ├── gemini.js         # Google Gemini (Flash, Pro)
│   ├── openrouter.js     # OpenRouter (Llama, Mistral, Gemini OR)
│   ├── claude-sonnet.js  # Anthropic Claude Sonnet 4
│   ├── claude-opus.js    # Anthropic Claude Opus 4
│   ├── swe.js            # SWE agent mode
│   └── normalize.js      # Normalizes provider responses to client format
├── store/                # Data access layer (DB + in-memory)
│   ├── sessions.js       # Session history — PostgreSQL (cross-run memory)
│   ├── context.js        # Context entries — PostgreSQL (patterns, fixes)
│   ├── subscriptions.js  # Plans, billing limits, usage checks
│   ├── usage.js          # Token usage tracking and cost calculation
│   ├── runs.js           # In-memory run state (active runs)
│   ├── tasks.js          # In-memory task state (active tasks)
│   ├── tool-results.js   # In-memory tool results (per-run)
│   ├── memory.js         # In-memory project memory
│   └── checkout-events.js# SSE event emitter for Stripe checkout
└── db/                   # Database layer
    ├── connection.js     # PostgreSQL pool, query helper, migration runner
    └── migrations/       # Schema migrations (001–009)
```

## Request Flow

### New User Prompt

```
Client → POST /agent/run { type: "user_message", content: "..." }
  → routes/agent.js
    → extractUser() — JWT auth
    → checkUsageAllowed() — billing limits
    → handlers/user-message.js
      → createTask() — build task with steps
      → loadProjectContext() — load memories, fixes
      → buildSessionSummary() — load chat history
      → buildContextForPrompt() — load DB patterns
      → callModelAdapter() — call AI provider
      → persistModelUsage() — log tokens + cost
      → mapNormalizedResponseToClient() — format response
  ← { status: "needs_tool", tool: "write_file", args: {...} }
```

### Tool Result Continuation

```
Client → POST /agent/run { type: "tool_result", runId: "...", tool: "...", result: {...} }
  → routes/agent.js
    → handlers/tool-result.js
      → saveToolResult() — store result
      → recordRunAction() — log for session history
      → callModelAdapter() — call AI for next action
      → persistModelUsage() — log tokens + cost
      → (if completed) saveSessionEntry(), autoSaveContext()
  ← { status: "needs_tool" | "completed" | "failed" }
```

## Database

PostgreSQL with auto-creation and auto-migration.

### Tables

| Table | Purpose |
|-------|---------|
| `_migrations` | Tracks which migrations have run |
| `sessions` | Completed/failed run summaries |
| `run_actions` | Per-step tool actions within runs |
| `users` | User accounts (email, hashed password) |
| `chats` | Chat sessions per user per project |
| `context_entries` | AI-learned patterns, fixes, memories |
| `subscriptions` | User plan, credits, billing status |
| `usage_logs` | Per-call token usage and cost |

## AI Providers

Each provider implements the same interface:
1. Accept a payload with task, context, and optional tool result
2. Maintain multi-turn conversation history per run
3. Return a normalized response: `{ kind, tool, args, reasoning, content }`

The system prompt includes:
- Tool definitions (read/write/edit files, run commands, etc.)
- Terminal command rules (never run server-start commands)
- Memory rules (use session history, don't repeat work)

## Billing

- **Free plan**: 10 prompts/day, cost logged as $0
- **Paid plans**: Credit-based, cost calculated per LLM call with model-specific pricing
- Stripe integration for checkout, webhooks, and subscription management
- SSE endpoint for real-time checkout completion notifications

## Environment Variables

See `.env.example` for all required and optional variables.
