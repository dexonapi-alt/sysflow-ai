# CLI Client Architecture

The Sysflow CLI (`sys`) is the terminal interface for the AI coding agent. It handles user interaction, local tool execution, and communicates with the server via REST.

## Directory Structure

```
cli-client/
├── bin/
│   └── sys.js                # Global entry point (#!/usr/bin/env node)
├── src/
│   ├── index.js              # CLI argument routing → commands or interactive mode
│   ├── agent/                # AI agent loop
│   │   ├── agent.js          # Main agent loop — display, reasoning, tool dispatch
│   │   ├── executor.js       # Tool execution dispatcher (routes to tool functions)
│   │   └── tools.js          # Tool implementations (file I/O, commands, search)
│   ├── commands/             # CLI subcommands
│   │   ├── auth.js           # sys login, sys register, sys logout, sys whoami
│   │   ├── billing.js        # sys billing — plan picker, usage display
│   │   ├── chats.js          # sys chats — list, create, switch, delete chats
│   │   └── model.js          # sys model — interactive model picker
│   ├── cli/                  # Terminal UI
│   │   ├── ui.js             # Interactive readline loop (the `| ` prompt)
│   │   └── parser.js         # CLI argument and slash-command parser
│   └── lib/                  # Shared utilities
│       ├── server.js         # HTTP client — POST /agent/run with JWT auth
│       └── sysbase.js        # Local config management (~/.sysflow + ./sysbase)
└── package.json
```

## How It Works

### Entry Points

1. **`sys`** (no args) → `startUi()` — interactive readline loop
2. **`sys "prompt"`** → `runAgent({ prompt })` — single-shot agent run
3. **`sys login`** / **`sys billing`** / etc. → specific command handlers

### Agent Loop (`agent/agent.js`)

The core loop that drives AI interaction:

```
1. Send user prompt to server (POST /agent/run, type: "user_message")
2. Server responds with: { status, tool, args, reasoning }
3. Loop:
   a. "completed" → print summary, exit
   b. "failed" → attempt recovery or abort
   c. "needs_tool" →
      - Display reasoning (typing animation)
      - Display tool action (+ create file.js, ✓ npm install, etc.)
      - Execute tool locally via executor.js
      - Send result to server (POST /agent/run, type: "tool_result")
      - Server responds with next action → back to step 3
```

### Tool Execution (`agent/tools.js`)

All tools run locally on the user's machine:

| Tool | Function | Description |
|------|----------|-------------|
| `list_directory` | `listDirectoryTool` | List files in a directory |
| `read_file` | `readFileTool` | Read file contents |
| `write_file` | `writeFileTool` | Create/overwrite a file |
| `edit_file` | `editFileTool` | Replace file contents |
| `create_directory` | `createDirectoryTool` | Create directory (recursive) |
| `move_file` | `moveFileTool` | Move or rename a file |
| `delete_file` | `deleteFileTool` | Delete a file |
| `search_code` | `searchCodeTool` | Grep/findstr for patterns |
| `run_command` | `runCommandTool` | Run shell commands (with timeout) |

#### Command Safety

- **Long-running commands** (`npm start`, `node server.js`, etc.) are detected and skipped — the AI tells the user to run them manually
- **30-second timeout** for all other commands — prevents hangs
- Commands use `spawn` (not `exec`) for proper process control

### Display Formatting

- **Reasoning**: Dim text with typing animation (`typeReasoning`)
- **Tool actions**: `+ create file.js +12` (green), `+ read file.js` (blue)
- **Commands**: Inline spinner → `✓ npm install` (green) or `✖ command` (red)
- **Dedup guard**: If AI repeats the same action, duplicate display is skipped

### Sysbase (`lib/sysbase.js`)

Local configuration stored in `./sysbase/` (per-project) and `~/.sysflow/` (global):

```
~/.sysflow/
├── auth.json          # JWT token, user info
├── models.json        # Selected model, reasoning toggle
└── active-chat.json   # Current chat session

./sysbase/             # Per-project (gitignored)
├── fixes/             # AI-generated fix files
├── memories/          # Project-specific memories
└── plans/             # Stored plans
```

### Server Communication (`lib/server.js`)

Single function `callServer(payload)` that:
- POSTs to `http://localhost:3000/agent/run`
- Includes JWT auth token from sysbase
- 5-minute timeout for slow LLM responses
- Handles 429 (usage limit) with friendly messages

## Commands

| Command | Handler | Description |
|---------|---------|-------------|
| `sys` | `cli/ui.js` | Interactive mode with readline |
| `sys "prompt"` | `agent/agent.js` | Run agent with prompt |
| `sys login` | `commands/auth.js` | Email/password login |
| `sys register` | `commands/auth.js` | Create account |
| `sys logout` | `commands/auth.js` | Clear auth tokens |
| `sys whoami` | `commands/auth.js` | Show account + usage info |
| `sys billing` | `commands/billing.js` | Plan picker + Stripe checkout |
| `sys usage` | `commands/billing.js` | Show token usage summary |
| `sys model` | `commands/model.js` | Interactive model picker |
| `sys chats` | `commands/chats.js` | List/create/switch chats |

## Installation

```bash
cd cli-client
npm install
npm link    # Makes `sys` available globally
```

The CLI connects to the server at `http://localhost:3000` by default. Override with `SYS_SERVER_URL` environment variable.
