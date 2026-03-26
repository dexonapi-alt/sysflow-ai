# Dependencies

## Server

| Package | Role |
|---------|------|
| `fastify` | HTTP framework (v5.x) |
| `@fastify/cors` | CORS middleware |
| `@google/generative-ai` | Gemini API client |
| `@anthropic-ai/sdk` | Claude API client |
| `pg` | PostgreSQL driver |
| `node-pg-migrate` | Database migrations |
| `bcrypt` | Password hashing |
| `jsonwebtoken` | JWT auth tokens |
| `stripe` | Payment processing |
| `uuid` | Unique ID generation |
| `dotenv` | Environment variables |
| `tsx` | TypeScript execution (dev) |
| `typescript` | Type checking |

## CLI Client

| Package | Role |
|---------|------|
| `chalk` | Terminal colors |
| `ora` | Loading spinners |
| `inquirer` | Interactive prompts |
| `ws` | WebSocket client |
| `node-fetch` | HTTP requests |
| `tsx` | TypeScript execution (dev) |
| `typescript` | Type checking |

## Dev Notes
- Both projects use `tsx` for development (no build step needed)
- `npm run dev` starts watch mode in both
- Target: ES2022, Module resolution: bundler
