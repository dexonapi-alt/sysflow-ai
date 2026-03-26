# CLI Client Architecture

> Location: `cli-client/src/`
> Installed as: `sys` command
> Language: TypeScript (strict, ES2022)

## Directory Layout

```
cli-client/src/
├── index.ts              # Entry point, CLI routing
├── agent/                # AI agent loop
│   ├── agent.ts          # Main loop (display, reasoning, tools)
│   ├── executor.ts       # Tool execution dispatcher
│   └── tools.ts          # Tool implementations
├── commands/             # CLI commands
│   ├── auth.ts           # login, register, logout, whoami
│   ├── billing.ts        # Plan picker, usage display
│   ├── chats.ts          # Chat session management
│   └── model.ts          # Model selection UI
├── cli/                  # Terminal UI
│   ├── ui.ts             # Interactive readline interface
│   └── parser.ts         # CLI argument parser
└── lib/                  # Shared utilities
    ├── server.ts         # HTTP client for server API
    └── sysbase.ts        # Local config & project memory
```

## Entry Points

```bash
sys "prompt here"         # One-shot mode
sys                       # Interactive mode
sys login                 # Auth commands
sys model                 # Model picker
sys billing               # Billing commands
sys chats                 # Chat management
```

## Agent Loop (`agent/agent.ts`)

```
1. Send user message to server (POST /agent/run)
2. Receive AI response
3. Display reasoning (typewriter effect)
4. If kind == "needs_tool":
   a. Display tool label (color-coded)
   b. Execute tool locally via executor
   c. Send tool result back to server
   d. Go to step 2
5. If kind == "completed": Display content, return to prompt
6. If kind == "failed": Display error, return to prompt
```

## Available Tools

| Tool | Function | Description |
|------|----------|-------------|
| list_directory | `listDirectoryTool()` | List directory contents |
| file_exists | `fileExistsTool()` | Check if file exists |
| create_directory | `createDirectoryTool()` | Create directory (recursive) |
| read_file | `readFileTool()` | Read file contents (UTF-8) |
| batch_read | loops `readFileTool()` | Read multiple files at once |
| write_file | `writeFileTool()` | Write/create file (creates parent dirs) |
| edit_file | `editFileTool()` | Full file replacement (not diff-based) |
| move_file | `moveFileTool()` | Move/rename file (creates parent dirs) |
| delete_file | `deleteFileTool()` | Delete file |
| search_code | `searchCodeTool()` | Search with grep (Unix) / findstr (Windows) |
| run_command | `runCommandTool()` | Shell commands (30s timeout, long-running detected & skipped) |

## Agent Features

- **File mentions**: `@filepath` syntax reads files into context before sending prompt
- **Error recovery**: Up to 3 consecutive error retries before aborting
- **Typing effect**: Reasoning displayed character-by-character
- **Diff display**: Shows added/removed line counts for write/edit operations
- **Dedup guard**: Skips duplicate display if AI repeats the same action
- **Long-running detection**: Commands like `npm start`, `node server.js` are detected and skipped

## Local Storage (sysbase)

```
./sysbase/                # Per-project, in project root
├── .meta/
│   ├── models.json       # Selected model
│   └── chat.json         # Active chat session
├── plans/                # Saved plans
├── patterns/             # Patterns
├── fixes/                # Fix/lesson files (read by server as context)
├── architecture/         # Architecture notes
├── decisions/            # Decision records
└── archive/              # Archived items

~/.sysflow/
└── auth.json             # JWT token (global, per-user)
```

## Interactive UI Commands

| Command | Action |
|---------|--------|
| `/model` | Switch AI model |
| `/chats` | Chat management |
| `/billing` | View billing/plans |
| `/usage` | View usage stats |
| `/continue` | Continue interrupted task |
| `/exit` | Exit CLI |
