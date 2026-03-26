# Current Project Status

> Last updated: 2026-03-26

## Recent Work

The project just completed a **TypeScript migration**:

- Converted all CLI modules to TypeScript (agent, commands, CLI, lib)
- Fixed TypeScript errors in server tool-result and billing routes
- Updated README to reflect TypeScript migration

## What's Done

- Full server with Fastify 5.x, routes, handlers, providers, stores
- PostgreSQL schema with 9 migrations (auto-run on startup)
- Multi-provider AI system (Gemini, OpenRouter functional; Claude Sonnet/Opus **mocked**)
- SWE mock provider for demo/testing (deterministic 20+ step auth system build)
- CLI client with agent loop, 11 tools, interactive UI
- Authentication (register, login, JWT with 30-day expiry)
- Billing integration (Stripe checkout, webhooks, SSE stream, 4 plans)
- Chat session management with project scoping
- Context auto-save system (memories on success, fixes on failure)
- Fix files auto-written to `sysbase/fixes/` on failed tasks
- File mention syntax (`@filepath`) in prompts
- TypeScript migration complete (strict mode, ES2022)

## What's NOT Done / Needs Work

- **Claude Sonnet provider**: Returns mock responses (TODO in code)
- **Claude Opus provider**: Returns mock responses (TODO in code)
- **docs/ still reference .js files**: docs/server.md and docs/cli-client.md show `.js` extensions (pre-migration)
- **No refresh token mechanism**: JWT expires after 30 days, no renewal
- **Default JWT_SECRET is weak**: `"sysflow-secret-change-me"` in production default

## Branch State

- **Main branch**: clean, all committed
- Latest commit: `ecd647f` — docs: update README for TypeScript migration

## Known Architecture Notes

- In-memory stores (runs, tasks, tool-results, memory) **reset on server restart**
- Only `openrouter-auto` and `gemini-flash` are visible in CLI model picker
- Tool execution has a 30-second timeout on `run_command`
- Server has a 5-minute per-request timeout
- `edit_file` tool does full file replacement, not diff-based editing
- Long-running commands (npm start, etc.) are detected and skipped by CLI
- Free plan tracks prompts via `free_prompts_today`/`free_prompts_reset_at` on users table
- Paid plans use credit system (NUMERIC cents in DB)
- Session history limited to 20 entries in AI prompts, 50 in chat view
- Orphaned sessions (from interrupted runs) are auto-saved as "interrupted"
