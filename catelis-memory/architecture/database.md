# Database Architecture

> Engine: PostgreSQL 16 (Alpine, via Docker)
> Driver: `pg` (node-postgres)
> Migrations: `server/src/db/migrations/` (auto-run on startup)

## Connection

- File: `server/src/db/connection.ts`
- Pool-based connection
- Migrations run automatically when server starts
- Config from env vars: DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME

## Tables

### users
| Column | Type | Notes |
|--------|------|-------|
| id | SERIAL PK | |
| username | VARCHAR UNIQUE | |
| password_hash | VARCHAR | bcrypt |
| created_at | TIMESTAMP | |

### chats
| Column | Type | Notes |
|--------|------|-------|
| id | SERIAL PK | |
| user_id | INT FK→users | |
| project_id | VARCHAR | |
| chat_uid | VARCHAR UNIQUE | Client-generated |
| title | VARCHAR | |
| model | VARCHAR | |
| status | VARCHAR | |
| created_at | TIMESTAMP | |
| updated_at | TIMESTAMP | |

### sessions
| Column | Type | Notes |
|--------|------|-------|
| id | SERIAL PK | |
| run_id | VARCHAR | |
| project_id | VARCHAR | |
| user_id | INT FK→users | Added in migration 005 |
| chat_id | INT FK→chats | Added in migration 005 |
| prompt | TEXT | |
| model | VARCHAR | |
| outcome | TEXT | |
| error | TEXT | |
| files_modified | TEXT[] | |
| created_at | TIMESTAMP | |

### run_actions
| Column | Type | Notes |
|--------|------|-------|
| id | SERIAL PK | |
| run_id | VARCHAR | |
| project_id | VARCHAR | |
| tool | VARCHAR | |
| path | VARCHAR | |
| command | VARCHAR | |
| extra | JSONB | |
| created_at | TIMESTAMP | |

### context_entries
| Column | Type | Notes |
|--------|------|-------|
| id | SERIAL PK | |
| project_id | VARCHAR | |
| user_id | INT FK→users | |
| category | VARCHAR | |
| title | VARCHAR | |
| content | TEXT | |
| tags | TEXT[] | |
| created_at | TIMESTAMP | |
| updated_at | TIMESTAMP | |

### subscriptions
| Column | Type | Notes |
|--------|------|-------|
| id | SERIAL PK | |
| user_id | INT FK→users | |
| stripe_customer_id | VARCHAR | |
| stripe_subscription_id | VARCHAR | |
| plan | VARCHAR | free, lite, pro, team |
| credits_cents | NUMERIC | Changed from INT in migration 009 |
| credits_used_cents | NUMERIC | |
| period_start | TIMESTAMP | |
| period_end | TIMESTAMP | |
| status | VARCHAR | |
| created_at | TIMESTAMP | |
| updated_at | TIMESTAMP | |

### usage_logs
| Column | Type | Notes |
|--------|------|-------|
| id | SERIAL PK | |
| user_id | INT FK→users | |
| model | VARCHAR | |
| input_tokens | INT | |
| output_tokens | INT | |
| cost_cents | NUMERIC | |
| created_at | TIMESTAMP | |

## Migrations (9 total)

| # | File | What it does |
|---|------|-------------|
| 001 | sessions | Create sessions table |
| 002 | run_actions | Create run_actions table |
| 003 | users | Create users table |
| 004 | chats | Create chats table |
| 005 | session_user_chat | Add user_id, chat_id to sessions |
| 006 | context_entries | Create context_entries table |
| 007 | subscriptions | Create subscriptions table |
| 008 | usage_logs | Create usage_logs table + add free_prompts_today/free_prompts_reset_at to users |
| 009 | alter_subscriptions | Change credits_cents to NUMERIC |

## Adding a New Migration

1. Create `server/src/db/migrations/0XX-description.sql`
2. Follow the naming pattern: zero-padded number + description
3. Migrations auto-run on server startup in order
