# Tool Execution Pattern

> Tools are defined on the server (in system prompt), executed on the client

## How It Works

1. AI provider receives tool definitions in the system prompt
2. AI responds with `{ kind: "needs_tool", tool: "tool_name", args: { ... } }`
3. CLI's `executor.ts` maps tool name to function in `tools.ts`
4. Tool function runs locally, returns result string
5. Result sent back to server as `{ type: "tool_result", toolResult: { tool, result } }`

## Tool Implementations

All in `cli-client/src/agent/tools.ts`:

| Tool | Args | Returns |
|------|------|---------|
| `list_directory` | `{ path }` | Directory listing |
| `file_exists` | `{ path }` | "true" or "false" |
| `create_directory` | `{ path }` | Success message |
| `read_file` | `{ path }` | File contents |
| `write_file` | `{ path, content }` | Success message |
| `edit_file` | `{ path, old_text, new_text }` | Success message |
| `move_file` | `{ source, destination }` | Success message |
| `delete_file` | `{ path }` | Success message |
| `search_code` | `{ pattern, path? }` | Grep/findstr results |
| `run_command` | `{ command }` | Command stdout+stderr (30s timeout) |

## Important Details

- `edit_file` is a **full file replacement**, not a diff/patch operation
- `run_command` detects long-running patterns (npm start, node server.js, etc.) and returns `{skipped: true}` instead of executing
- `run_command` captures last 4000 chars of stdout, 2000 of stderr (prevents huge responses)
- `search_code` uses `findstr` on Windows, `grep` on Unix
- `batch_read` reads multiple files in a loop with per-file error handling
- Shell: `cmd.exe` on Windows, `/bin/sh` on Unix

## Adding a New Tool

1. Add tool function in `cli-client/src/agent/tools.ts`
2. Add case in `cli-client/src/agent/executor.ts` dispatcher
3. Add tool description in provider system prompt (`server/src/providers/base-provider.ts`)
4. Update this file
