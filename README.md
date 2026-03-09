# Sysflow

AI-powered coding agent that runs in your terminal. Write prompts, and Sysflow reads, writes, and executes code on your behalf.

Built with **TypeScript**. AI model providers use an **OOP class-based architecture** (BaseProvider + subclasses), while the rest of the codebase follows a **functional style**.

## Architecture

```
sysflow/
├── server/            # Fastify API — orchestrates AI models, manages state
├── cli-client/        # CLI tool — terminal UI, local tool execution
├── docs/              # Developer documentation
├── docker-compose.yml
└── .gitignore
```

**Server** handles AI model communication (Gemini, OpenRouter), session history, billing, auth, and project context. It stores data in PostgreSQL.

**CLI Client** is installed globally as `sys`. It provides the interactive terminal UI, executes file/command tools locally, and communicates with the server via REST.

## How It Works

```
  You type: sys "create an express server"
           |
           v
  ┌─────────────────┐
  │   CLI Client     │  Scans project folder, sends prompt + file tree
  └────────┬────────┘
           |  POST /agent/run { type: "user_message" }
           v
  ┌─────────────────┐
  │   API Server     │  Auth → usage check → load context → load session history
  └────────┬────────┘
           |  API call (Gemini / OpenRouter)
           v
  ┌─────────────────┐
  │   AI Model       │  Receives system prompt + tools + context + your prompt
  │                  │  Returns: { tool: "write_file", args: {...} }
  └────────┬────────┘
           |
           v
  ┌─────────────────┐
  │   API Server     │  Logs usage, normalizes response
  └────────┬────────┘
           |  { status: "needs_tool", tool: "write_file", args: {...} }
           v
  ┌─────────────────┐
  │   CLI Client     │  Displays reasoning → executes tool locally → sends result back
  └────────┬────────┘
           |  POST /agent/run { type: "tool_result" }
           v
       Server → AI → Server → CLI → ...
       Loop repeats until AI responds "completed" or "failed"
```

**Key point:** The AI never touches your files directly. It only *decides* what to do. The CLI executes tools locally on your machine.

The server persists session history in PostgreSQL, so the AI remembers what it did across prompts within the same chat session.

## Quick Start

### Prerequisites

- Node.js 20+
- PostgreSQL 15+ (or Docker)
- API key for at least one provider (Gemini or OpenRouter)
- TypeScript runs via [tsx](https://github.com/privatenumber/tsx) — no separate build step needed

### 1. Clone & Install

```bash
git clone https://github.com/your-org/sysflow.git
cd sysflow

# Start PostgreSQL with Docker (or use local PostgreSQL)
docker compose up -d postgres

# Server
cd server
npm install
cp .env.example .env   # Fill in your API keys

# CLI Client
cd ../cli-client
npm install
npm link               # Makes `sys` available globally
```

### 2. Start the Server

```bash
cd server
npm run dev            # Starts with --watch for auto-reload
```

The server auto-creates the database and runs all migrations on startup.

### 3. Use the CLI

```bash
# Create account and log in
sys register
sys login

# Pick a model
sys model

# Navigate to any project directory
cd ~/my-project

# Direct prompt
sys "create a REST API with Express"

# Interactive mode (multiple prompts in a session)
sys

# Other commands
sys whoami             # Show account info + usage
sys billing            # Manage subscription
sys chats              # Manage chat sessions
sys usage              # Show token usage
```

## Environment Variables

Create `server/.env` (see `server/.env.example`):

```env
# Database (defaults work with Docker)
DB_HOST=localhost
DB_PORT=5432
DB_USER=postgres
DB_PASSWORD=postgres
DB_NAME=sysflow

# AI Providers (at least one required)
GEMINI_API_KEY=
OPENROUTER_API_KEY=

# Auth
JWT_SECRET=change-me-in-production

# Stripe (optional — for billing)
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
```

**Where to get keys:**
- **Gemini:** [aistudio.google.com](https://aistudio.google.com/apikey) → Free
- **OpenRouter:** [openrouter.ai/keys](https://openrouter.ai/keys) → Free (no credit card)

## Docker

```bash
docker compose up -d           # Starts PostgreSQL + server
docker compose up -d postgres  # Start only PostgreSQL (run server locally)
```

## Available Models

| ID | Provider | Description |
|----|----------|-------------|
| `openrouter-auto` | OpenRouter | Auto-selects best available model |
| `gemini-flash` | Google | Gemini 2.5 Flash — fast & free |

More models (Gemini Pro, Llama 70B, Mistral, Claude) exist in the server but are currently hidden from the picker.

## Project Structure

### Server (`server/`)

```
server/src/
├── index.ts                 # Entry point — Fastify setup, route registration
├── types.ts                 # Shared TypeScript interfaces and types
├── services/                # Business logic
│   ├── context.ts           # Project context loading (memories, fixes)
│   └── task.ts              # Task creation and step management
├── routes/                  # HTTP endpoints
│   ├── agent.ts             # POST /agent/run — main AI endpoint
│   ├── auth.ts              # POST /auth/register, /auth/login
│   ├── chats.ts             # CRUD /chats
│   └── billing.ts           # Stripe billing, usage, plans
├── handlers/                # Request orchestration
│   ├── user-message.ts      # Handles new user prompts
│   └── tool-result.ts       # Handles tool execution results
├── providers/               # AI model adapters (OOP — BaseProvider + subclasses)
│   ├── base-provider.ts     # Abstract base class with shared logic
│   ├── adapter.ts           # Provider registry and model router
│   ├── gemini.ts            # Google Gemini provider
│   ├── openrouter.ts        # OpenRouter provider (Llama, Mistral, etc.)
│   ├── claude-sonnet.ts     # Anthropic Claude Sonnet provider
│   ├── claude-opus.ts       # Anthropic Claude Opus provider
│   ├── swe.ts               # Mock provider for testing
│   └── normalize.ts         # Response normalization
├── store/                   # Data access layer
│   ├── sessions.ts          # Session history (PostgreSQL)
│   ├── context.ts           # Context entries (PostgreSQL)
│   ├── subscriptions.ts     # Plans, billing, usage limits
│   ├── usage.ts             # Token usage tracking
│   ├── runs.ts              # In-memory run state
│   ├── tasks.ts             # In-memory task state
│   ├── tool-results.ts      # In-memory tool results
│   ├── memory.ts            # In-memory project memory
│   └── checkout-events.ts   # SSE checkout notifications
└── db/                      # Database
    ├── connection.ts         # PostgreSQL pool, migrations runner
    └── migrations/           # Schema migrations (001–009, plain JS)
```

### CLI Client (`cli-client/`)

```
cli-client/src/
├── index.ts                 # Entry point — CLI argument routing
├── agent/                   # AI agent loop
│   ├── agent.ts             # Main agent loop (display, reasoning, tools)
│   ├── executor.ts          # Tool execution dispatcher
│   └── tools.ts             # Tool implementations (file ops, commands)
├── commands/                # CLI commands
│   ├── auth.ts              # login, register, logout, whoami
│   ├── billing.ts           # Plan picker, usage display
│   ├── chats.ts             # Chat session management
│   └── model.ts             # Model selection UI
├── cli/                     # Terminal UI
│   ├── ui.ts                # Interactive readline interface
│   └── parser.ts            # CLI argument parser
└── lib/                     # Shared utilities
    ├── server.ts             # HTTP client for server communication
    └── sysbase.ts            # Local config and sysbase management
```

## Documentation

For comprehensive documentation, see:

- **[docs/general-doc.md](docs/general-doc.md)** — Full guide: setup, usage, architecture, agent loop, tools, providers, billing, troubleshooting
- **[docs/server.md](docs/server.md)** — Server architecture deep dive
- **[docs/cli-client.md](docs/cli-client.md)** — CLI architecture deep dive

## License

MIT
