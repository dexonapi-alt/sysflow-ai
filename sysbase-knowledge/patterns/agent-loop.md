# Agent Loop Pattern

> The core execution cycle of Sysflow

## Flow

```
User Input
    │
    ▼
CLI: Scan directory tree
    │
    ▼
CLI → Server: POST /agent/run { type: "user_message" }
    │
    ▼
Server: Load context
  - Session history (last 20 from DB)
  - Project memory (in-memory store)
  - Fixes/lessons (from sysbase/fixes/)
  - Continue context (if resuming)
    │
    ▼
Server: Call AI provider
  - System prompt with tool definitions
  - Directory tree
  - Context bundle
    │
    ▼
AI Response (normalized)
    │
    ├─► kind: "completed" → Display content → Done
    ├─► kind: "failed" → Display error → Done
    ├─► kind: "waiting_for_user" → Prompt user → Loop
    └─► kind: "needs_tool" → Continue below
            │
            ▼
        CLI: Execute tool locally
            │
            ▼
        CLI → Server: POST /agent/run { type: "tool_result" }
            │
            ▼
        Server: Call AI with tool result
            │
            ▼
        (Back to AI Response)
```

## Key Files

- Agent loop: `cli-client/src/agent/agent.ts`
- Tool executor: `cli-client/src/agent/executor.ts`
- Server route: `server/src/routes/agent.ts`
- User message handler: `server/src/handlers/user-message.ts`
- Tool result handler: `server/src/handlers/tool-result.ts`

## Important Details

- Server maintains per-run state in memory (chat history for multi-turn within a run)
- CLI sends the full directory tree with every request
- Tool execution happens entirely on the client side — server never runs commands
- The 5-minute timeout on the server applies to each individual request, not the full loop
- Each tool result is sent as a separate HTTP request (not streaming)
