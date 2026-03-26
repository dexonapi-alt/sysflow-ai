# Naming Conventions

## Files
- **kebab-case** for all filenames: `user-message.ts`, `base-provider.ts`, `tool-results.ts`
- TypeScript files only (`.ts`), no `.js` in source

## Database
- **snake_case** for table and column names: `usage_logs`, `created_at`, `user_id`
- Foreign keys: `<table_singular>_id` (e.g., `user_id`, `chat_id`)
- Timestamps: `created_at`, `updated_at`

## API
- **kebab-case** for URL paths: `/agent/run`, `/auth/login`, `/billing/checkout`
- **camelCase** for JSON request/response bodies: `userMessage`, `directoryTree`, `chatUid`

## Code
- **camelCase** for variables and functions: `getProvider()`, `executeTool()`, `buildInitialUserMessage()`
- **PascalCase** for classes and types: `BaseProvider`, `GeminiProvider`, `NormalizedResponse`
- **UPPER_SNAKE_CASE** for constants: `SYSBASE_DIR`, `AUTH_FILE`, `JWT_SECRET`

## Tool Names
- **snake_case**: `read_file`, `write_file`, `run_command`, `search_code`

## Migration Files
- `0XX-description.sql` — zero-padded number, kebab-case description
