# Authentication Flow

## Registration
1. User runs `sys register`
2. CLI prompts for username + password
3. CLI sends `POST /auth/register { username, password }`
4. Server hashes password with bcrypt, stores in `users` table
5. Server returns JWT token (30-day expiry)
6. CLI saves token to `~/.sysflow/auth.json`

## Login
1. User runs `sys login`
2. CLI prompts for username + password
3. CLI sends `POST /auth/login { username, password }`
4. Server verifies with bcrypt, returns JWT
5. CLI saves token to `~/.sysflow/auth.json`

## Authenticated Requests
- CLI reads token from `~/.sysflow/auth.json`
- Sends as `Authorization: Bearer <token>` header
- Server decodes JWT: `{ userId, username }`
- JWT_SECRET from env (default: "sysflow-secret-change-me")

## Key Files
- Server auth routes: `server/src/routes/auth.ts`
- CLI auth commands: `cli-client/src/commands/auth.ts`
- CLI HTTP client: `cli-client/src/lib/server.ts`
- Auth storage: `~/.sysflow/auth.json`
