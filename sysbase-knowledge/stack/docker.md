# Docker Setup

> File: `docker-compose.yml`

## Services

### postgres
- Image: `postgres:16-alpine`
- Port: `5432:5432`
- Credentials: `postgres/postgres`
- Database: `sysflow`
- Health check: `pg_isready`
- Volume: `pgdata` (persistent)

### server
- Build: `./server/Dockerfile`
- Port: `3000:3000`
- Depends on: postgres (waits for healthy)
- Env: loaded from `.env` file

## Usage

```bash
# Start everything
docker-compose up -d

# Just the database (for local dev)
docker-compose up -d postgres

# View logs
docker-compose logs -f server
```

## Local Development Without Docker

```bash
# Terminal 1: Start Postgres (or use Docker just for DB)
docker-compose up -d postgres

# Terminal 2: Start server
cd server && npm run dev

# Terminal 3: Use CLI
cd cli-client && npm run dev -- "your prompt"
```
