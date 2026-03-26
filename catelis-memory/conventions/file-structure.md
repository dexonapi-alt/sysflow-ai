# File Structure Conventions

## Server (`server/src/`)

| Folder | Purpose | Rule |
|--------|---------|------|
| `routes/` | HTTP endpoint definitions | One file per resource domain |
| `handlers/` | Request orchestration logic | Called by routes, calls providers/stores |
| `providers/` | AI model adapters | One class per provider, extend BaseProvider |
| `services/` | Business logic | Shared logic used by handlers |
| `store/` | Data access | One file per data domain (DB or in-memory) |
| `db/` | Database connection + migrations | Migrations are numbered SQL files |

## CLI Client (`cli-client/src/`)

| Folder | Purpose | Rule |
|--------|---------|------|
| `agent/` | Agent loop + tool execution | Core runtime |
| `commands/` | CLI subcommands | One file per command group |
| `cli/` | Terminal UI + argument parsing | UI and parser |
| `lib/` | Shared utilities | Server client, local config |

## Key Principle

- **Server never executes tools** — it only decides what tool to call
- **CLI never calls AI** — it only executes tools and relays results
- **Routes are thin** — they validate + route, handlers do the work
