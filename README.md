<div align="center">

# Sysflow

### The **free** AI coding agent — Claude-Code workflow, no API bill.

Powered by **OpenRouter Auto** (free tier) and **Gemini Flash** (free tier). Same multi-step agent loop, same scaffold-and-customise flow, same reasoning system you'd pay for elsewhere — running on your terminal for $0.

[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://typescriptlang.org/)
[![Fastify](https://img.shields.io/badge/Fastify-000000?style=flat-square&logo=fastify&logoColor=white)](https://fastify.dev/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-4169E1?style=flat-square&logo=postgresql&logoColor=white)](https://postgresql.org/)
[![OpenRouter](https://img.shields.io/badge/OpenRouter-6366F1?style=flat-square&logo=openai&logoColor=white)](https://openrouter.ai/)
[![Google Gemini](https://img.shields.io/badge/Gemini-8E75B2?style=flat-square&logo=googlegemini&logoColor=white)](https://ai.google.dev/)
[![Docker](https://img.shields.io/badge/Docker-2496ED?style=flat-square&logo=docker&logoColor=white)](https://docker.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow?style=flat-square)](LICENSE)

**Prompt it. Watch it think. Let it ship — without burning credits.**

</div>

---

## Why Sysflow exists

Claude Code, Cursor, and the other premium AI coding agents are great. They're also expensive. Every prompt is a per-token bill. Every iteration is a few cents. A real day of work adds up.

**Sysflow gives you the same kind of agent — multi-step reasoning, tool use, scaffold-first project init, mid-execution decisions — running on free models.**

The model isn't what makes those tools good. The orchestrator is — the loop that decides what to do next, the reasoner that asks before guessing, the permission system that keeps your machine safe, the scaffold-recommender that runs `npm create vite` instead of hand-writing 15 config files. Sysflow ships all of that and points it at OpenRouter Auto + Gemini Flash.

You get a real agent workflow. You don't get a real bill.

---

## What you get

### The same agent capabilities, free
- **Pre-flight reasoning** that classifies your task, picks a stack, and asks for missing context (Sheet ID, API keys, schema) before guessing
- **Self-invoked `reason` tool** the agent calls itself when it hits a fork (which ORM? safe to delete this file?)
- **On-error recovery** with ranked hypotheses + invalidating tests after consecutive tool failures
- **On-completion summary** that rewrites the final message into clusters + what-matters + verification steps
- **22-stack scaffold-first init** — `create a react app for a todo list` runs `npm create vite@latest todo-list -- --template react-ts` and then customises, instead of hand-writing files
- **Permission system** with allow/deny/ask + persistent rules + 4 modes (default / auto / plan / bypass)
- **Hook registry** with built-in audit log + secrets-block (refuses writes to `.env*`, `*.pem`, `id_rsa*`, `secrets.*`)
- **Plan mode** that produces a plan and waits for your nod before touching disk
- **Daily-rotated audit log** + per-run usage telemetry under `<sysbasePath>/`

### Free model defaults
- **OpenRouter Auto** routes to the best available *free* model for each prompt — DeepSeek, Llama, Mistral, Gemini-via-OR, Qwen
- **Gemini Flash** has a generous free tier (15 RPM / 1000 RPD) directly from Google AI Studio
- **Both providers swap in seconds** via `/model` — your work isn't tied to a single vendor

### Local-first, transparent
- The model decides; **your machine executes** every tool call
- Reasoning brief renders in the terminal so you see *why* it picked the stack before it runs
- Diffs are previewed inline; Tab expands the full change

---

## How it differs from "just another AI coder"

| | Sysflow | Premium agents | Toy wrappers |
|---|---|---|---|
| **Cost** | Free model defaults | $$$ per prompt | Free but shallow |
| **Multi-step loop** | Yes — full agent | Yes | One-shot only |
| **Reasoning before acting** | Pre-flight + self-invoked + on-error + on-completion | Varies | None |
| **Ask vs guess on missing context** | Strict ask-gate | Strict | Guesses |
| **Scaffold-first project init** | 22 stacks, auto-trusted | Hand-writes files | Hand-writes files |
| **Permission system** | 4 modes + per-tool gates + persistent rules | Yes | None |
| **Audit + telemetry** | Daily-rotated JSONL | Hosted | None |
| **Local execution** | Yes — model never touches your files | Yes | Yes |
| **Pluggable providers** | OpenRouter, Gemini, Claude scaffolds | One vendor | One vendor |

---

## The promise

**A real coding agent. Free models by default. Your control.**

Sysflow goes from idea → working code with the same tool-use sophistication as the agents you'd pay for. The multi-step loop, the reasoning briefs, the scaffold-first project init, the permission system — all of it works on OpenRouter's free tier.

If you want to upgrade later, the architecture supports paid providers (Claude scaffolds are in the codebase). But the default works for free, and most projects never need anything else.

---

## Quick start

### Prerequisites
- Node.js 20+
- PostgreSQL 15+ (or Docker)
- Free API key from [OpenRouter](https://openrouter.ai/keys) and/or [Google AI Studio](https://aistudio.google.com/apikey)

### 1. Clone

```bash
git clone https://github.com/dexonapi-alt/sysflow-ai.git
cd sysflow-ai
```

### 2. Start Postgres

```bash
docker compose up -d postgres
```

### 3. Set up the server

```bash
cd server
npm install
cp .env.example .env
# Fill in OPENROUTER_API_KEY and/or GEMINI_API_KEY
npm run dev
```

### 4. Set up the CLI (in a new terminal)

```bash
cd cli-client
npm install
npm link    # makes `sys` globally available
```

### 5. Use it

```bash
sys register
sys login
cd ~/my-project
sys "create a react app for a todo list"
```

Default model is **`openrouter-auto`** (free). Switch with `sys model gemini-flash` (also free).

---

## Example workflows

### One-shot

```bash
sys "create a discord bot that posts daily memes"
```

The reasoner asks for the bot token + channel ID + meme source before writing a single file.

### Scaffold + customise

```bash
sys "build me a portfolio site"
```

In an empty dir, the recommender runs `npm create vite@latest portfolio-site -- --template react-ts`, the permission system asks once for `npm install`, then the agent customises App.tsx for the user's content.

### Interactive mode

```bash
sys
```

REPL stays in one chat — context survives prompts.

### Plan first, then implement

```bash
sys
> /plan-mode on
> build a REST API for user management
# agent proposes a plan; nothing touches disk
> /plan-mode off
> go ahead, implement it
```

### Switch model mid-conversation

```bash
> /model gemini-flash
```

### Target a file

```bash
sys "refactor @src/app.js to use async/await"
```

---

## CLI commands

| Command | What it does |
|---|---|
| `sys` | Start interactive mode |
| `sys "prompt"` | Run a one-shot prompt |
| `sys register` / `sys login` | Account management |
| `sys whoami` / `sys usage` | View account + usage |
| `sys model [<id>]` | Open the model picker or switch directly |
| `sys chats` / `sys delete chat` | Manage chat sessions |
| `sys billing` | Optional — only if you upgrade to paid plans |

### Inside interactive mode

| Slash | What it does |
|---|---|
| `/model [<id>]` | Pick a model |
| `/mode <default\|auto\|plan\|bypass>` | Switch the permission mode |
| `/permissions [list\|remove n\|clear]` | Manage saved allow/deny rules |
| `/plan-mode [on\|off]` | Toggle plan mode |
| `/memory` | Inspect the persistent reasoning memory for this project |
| `/remember <text>` | Add a verbatim user correction to memory |
| `/continue` | Resume the last interrupted run |
| `/exit` / `/quit` | Leave |

---

## Available models

Default visible options:

- **`openrouter-auto`** — best available **free** model via OpenRouter (DeepSeek / Llama / Qwen / etc.)
- **`gemini-flash`** — Google AI Studio direct, generous free tier

Provider scaffolds for Claude Sonnet / Opus exist in the codebase for users who want to plug in a paid key.

---

## How it works

### Two parts

**CLI Client** — what you use day to day. Scans the project, sends prompts + context to the server, displays the reasoning brief, executes tool calls locally on your machine.

**API Server** — orchestration: auth, usage limits, session history, project context, model routing, reasoning pipelines, response normalization.

### The loop

```text
You type a prompt
      ↓
Pre-flight reasoner classifies the task + picks a stack + checks missing context
      ↓
If context is missing → ask the user. Otherwise:
      ↓
If fresh project + canonical scaffolder → run it directly
      ↓
Otherwise the main agent loop runs:
      ↓
Model returns an action (read / write / edit / search / run_command / reason)
      ↓
CLI executes locally — permission system gates anything risky
      ↓
Result POSTs back; on-error reasoner kicks in if 2 tools failed
      ↓
Loop continues until the task is done
      ↓
On-completion reasoner refines the final summary
```

The model thinks. The CLI acts. You stay in control.

---

## Tech stack

**Server:** Fastify · TypeScript · PostgreSQL · Stripe (optional) · Zod · vitest
**CLI:** Node.js · TypeScript · Chalk · Ora · Zod · vitest
**Providers:** OpenRouter · Google Gemini · Anthropic-ready scaffolds
**Tooling:** Docker · tsx

---

## Architecture

```text
sysflow-ai/
├── cli-client/                 # Terminal client + local tool execution
│   └── src/
│       ├── agent/              # Agent loop, state machine, retry, permissions, hooks
│       ├── cli/                # Rendering, REPL, slash command parsing
│       └── lib/                # Server transport, sysbase config
├── server/                     # API server + orchestration
│   └── src/
│       ├── reasoning/          # Reasoning pipelines (pre-flight / self-invoked /
│       │                       # on-error / on-completion / chunk_plan / chunk_reflect / divergence)
│       ├── scaffold/           # 22-stack scaffolder registry + recommender
│       ├── memory-store/       # Persistent reasoning memory + recorder + validators
│       ├── services/           # chunk-state, divergence-detector, verification-gate,
│       │                       # confidence-tracker, action-planner, flags
│       ├── providers/prompt/   # Modular system prompt sections
│       ├── handlers/           # user_message + tool_result handlers
│       ├── routes/             # Fastify routes
│       └── store/              # Run, session, tool-result, audit storage
├── docs/                       # Architecture + improvement docs
├── docker-compose.yml
└── README.md
```

---

## Environment variables

Create `server/.env` from the example:

```bash
# Database
DB_HOST=localhost
DB_PORT=5432
DB_USER=postgres
DB_PASSWORD=postgres
DB_NAME=sysflow

# AI Providers — at least one required, both are free
OPENROUTER_API_KEY=     # https://openrouter.ai/keys
GEMINI_API_KEY=         # https://aistudio.google.com/apikey

# Auth
JWT_SECRET=change-me-in-production

# Self-host bypass — when running your own server with your own AI keys, the
# Free-plan daily prompt cap is just dev friction. Set to "true" to skip it.
SYSFLOW_BILLING_DISABLED=false

# Optional — only if running paid plans
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
```

---

## Who this is for

Sysflow is for:

- Developers who want a **real agent workflow** without paying per token
- Builders who prefer the **terminal** over a hosted IDE plugin
- Indie hackers shipping side projects on a budget
- Teams evaluating AI tooling without burning a budget line on a proof-of-concept
- Anyone who's been told "the model is what matters" — and wants proof that the **orchestrator** is what actually matters

---

## Documentation

- `docs/general-doc.md` — full product and architecture guide
- `docs/server.md` — server deep dive
- `docs/cli-client.md` — CLI deep dive
- `docs/sysflow-improvement/` — the 227-item gap inventory + phased roadmap
- `.claude/plans/applied/` — every shipped phase plan with completion notes

---

## License

MIT

<div align="center">

**Build for free. Stay in control. Ship with confidence.**

Sysflow — Claude-Code-grade agent, OpenRouter-Auto-grade bill.

</div>
