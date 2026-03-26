# System Overview

> Sysflow is an AI-powered coding agent that runs in the terminal.

## Architecture: Client-Server Split

```
┌─────────────┐         HTTP/REST         ┌─────────────────┐
│  CLI Client  │ ◄──────────────────────► │  Fastify Server  │
│  (local)     │                           │  (remote/local)  │
│              │                           │                  │
│  - Terminal UI│                          │  - AI Providers   │
│  - Tool exec  │                          │  - Auth/Billing  │
│  - File ops   │                          │  - PostgreSQL    │
└─────────────┘                           └─────────────────┘
```

**Key design principle:** The AI decides what to do (server-side). The CLI executes it locally. The AI never touches files directly.

## Data Flow (Single Turn)

1. User types prompt in CLI
2. CLI scans project directory tree
3. CLI sends `POST /agent/run` with `{ type: "user_message", userMessage, directoryTree, context }`
4. Server loads context (session history, project memory, fixes)
5. Server calls AI provider with system prompt + tools + context
6. AI responds with `{ kind: "needs_tool", tool, args }` or `{ kind: "completed", content }`
7. If tool needed: CLI executes tool locally, sends result back via `POST /agent/run` with `{ type: "tool_result" }`
8. Loop repeats until AI returns `completed` or `failed`

## Component Map

| Component | Location | Purpose |
|-----------|----------|---------|
| Server | `server/src/` | AI orchestration, auth, billing, persistence |
| CLI Client | `cli-client/src/` | Terminal UI, local tool execution |
| Database | PostgreSQL (Docker) | Sessions, users, chats, billing, context |
| Sysbase | `./sysbase/` (per-project) | Local config, model selection, project memory |
