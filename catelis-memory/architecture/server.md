# Server Architecture

> Location: `server/src/`
> Framework: Fastify 5.x
> Language: TypeScript (strict, ES2022)

## Directory Layout

```
server/src/
├── index.ts              # App init, route registration, 5-min timeout
├── types.ts              # Shared TypeScript interfaces
├── routes/               # HTTP endpoints
│   ├── agent.ts          # POST /agent/run — main AI endpoint
│   ├── auth.ts           # /auth/register, /auth/login, /auth/me
│   ├── chats.ts          # CRUD for chat sessions
│   └── billing.ts        # Stripe billing endpoints
├── handlers/             # Request orchestration
│   ├── user-message.ts   # Processes new user prompts
│   └── tool-result.ts    # Processes tool execution results
├── providers/            # AI model adapters (see providers.md)
├── services/             # Business logic
│   ├── context.ts        # Load project context/memories
│   └── task.ts           # Task creation & step tracking
├── store/                # Data access layer
│   ├── sessions.ts       # Session history (PostgreSQL)
│   ├── context.ts        # Context entries (PostgreSQL)
│   ├── subscriptions.ts  # Plans, credits, usage limits
│   ├── usage.ts          # Token usage tracking
│   ├── runs.ts           # In-memory run state
│   ├── tasks.ts          # In-memory task state
│   ├── tool-results.ts   # In-memory tool results
│   ├── memory.ts         # In-memory project memories
│   └── checkout-events.ts# SSE checkout notifications
└── db/
    ├── connection.ts     # PostgreSQL pool & auto-migrations
    └── migrations/       # 9 migrations (001–009)
```

## Routes

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/agent/run` | Yes | Main AI endpoint (user_message or tool_result) |
| POST | `/auth/register` | No | Create account |
| POST | `/auth/login` | No | Login, returns JWT |
| GET | `/auth/me` | Yes | Current user info |
| GET | `/chats` | Yes | List chats (optional projectId filter, max 20) |
| POST | `/chats` | Yes | Create chat |
| GET | `/chats/:chatUid` | Yes | Get chat with session history (50 sessions max) |
| PATCH | `/chats/:chatUid` | Yes | Update chat title |
| DELETE | `/chats/:chatUid` | Yes | Delete chat (cascades to sessions + run_actions) |
| GET | `/billing/plans` | Yes | List subscription plans |
| GET | `/billing/usage` | Yes | Current usage/credits (reconciles with Stripe) |
| POST | `/billing/checkout` | Yes | Create Stripe checkout session |
| POST | `/billing/webhook` | No | Stripe webhook (checkout, invoice, subscription) |
| GET | `/billing/checkout-stream` | Yes | SSE stream for checkout completion (15s heartbeat) |
| GET | `/billing/success` | No | Post-checkout redirect, updates subscription |
| GET | `/billing/cancel` | No | Checkout cancellation redirect |
| GET | `/health` | No | Health check |

## Request Flow (agent/run)

```
Route (agent.ts)
  → Check auth (JWT from Bearer token)
  → Check usage limits (subscriptions store)
  → Route by type:
    → "user_message" → user-message handler
    → "tool_result" → tool-result handler
  → Handler calls AI provider
  → Provider returns normalized response
  → Track usage (usage store)
  → Save session (sessions store)
  → Return response to CLI
```

## In-Memory vs Persistent State

| Store | Storage | Purpose |
|-------|---------|---------|
| `runs.ts` | In-memory Map | Active run state (cleared on restart) |
| `tasks.ts` | In-memory Map | Task tracking during runs |
| `tool-results.ts` | In-memory Map | Tool results during runs |
| `memory.ts` | In-memory Map | Project memories |
| `sessions.ts` | PostgreSQL | Session history (persistent) |
| `context.ts` | PostgreSQL | Context entries (persistent) |
| `subscriptions.ts` | PostgreSQL | Billing data (persistent) |
| `usage.ts` | PostgreSQL | Token usage logs (persistent) |
