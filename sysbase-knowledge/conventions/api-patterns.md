# API Patterns

## Request Format

### Agent Run (main endpoint)
```typescript
// User message
POST /agent/run
{
  type: "user_message",
  model: string,
  runId: string,
  userMessage: string,
  directoryTree: string,
  context: { sessionHistory, projectMemory, continueContext },
  task?: { id, title, steps }
}

// Tool result
POST /agent/run
{
  type: "tool_result",
  model: string,
  runId: string,
  toolResult: { tool: string, result: string }
}
```

## Response Format

All agent responses follow this shape:
```typescript
{
  status: "ok" | "error",
  // On success:
  tool?: string,
  args?: Record<string, unknown>,
  content?: string,
  reasoning?: string,
  // On error:
  error?: string
}
```

## Authentication

All authenticated routes expect:
```
Authorization: Bearer <JWT>
```

JWT payload: `{ userId: string, username: string }`

## Error Handling

- **401** — Missing or invalid token
- **429** — Usage limit exceeded (includes plan info in response)
- **500** — Server error

## Rate Limiting

- Checked before every `/agent/run` call
- Based on plan limits in `subscriptions` store
- Free plan: 10 prompts/day
- Paid plans: credit-based with monthly reset
