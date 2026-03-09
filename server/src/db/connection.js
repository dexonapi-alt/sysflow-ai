import pg from "pg"
const { Pool, Client } = pg

let pool = null

function getDbConfig() {
  return {
    host: process.env.DB_HOST || "localhost",
    port: parseInt(process.env.DB_PORT || "5432", 10),
    user: process.env.DB_USER || "postgres",
    password: process.env.DB_PASSWORD || "postgres",
    database: process.env.DB_NAME || "sysflow"
  }
}

/**
 * Automatically creates the "sysflow" database if it doesn't exist.
 * Connects to the default "postgres" database first to check/create.
 */
async function ensureDatabase() {
  const config = getDbConfig()
  const client = new Client({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: "postgres"
  })

  try {
    await client.connect()
    const res = await client.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [config.database]
    )

    if (res.rowCount === 0) {
      console.log(`[db] Creating database "${config.database}"...`)
      await client.query(`CREATE DATABASE "${config.database}"`)
      console.log(`[db] Database "${config.database}" created.`)
    } else {
      console.log(`[db] Database "${config.database}" already exists.`)
    }
  } finally {
    await client.end()
  }
}

/**
 * Returns the shared connection pool.
 */
export function getPool() {
  if (!pool) {
    pool = new Pool(getDbConfig())
  }
  return pool
}

/**
 * Run a single query using the shared pool.
 */
export async function query(text, params) {
  return getPool().query(text, params)
}

/**
 * Initialize the database: create if needed, then run migrations.
 */
export async function initDatabase() {
  await ensureDatabase()

  const p = getPool()

  // Test the connection
  const res = await p.query("SELECT NOW()")
  console.log(`[db] Connected to PostgreSQL at ${res.rows[0].now}`)

  // Run migrations
  await runMigrations(p)
}

/**
 * Simple built-in migration runner.
 * Tracks which migrations have run in a `_migrations` table.
 */
async function runMigrations(pool) {
  // Create migrations tracking table if not exists
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      ran_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  // Import migrations in order
  const migrations = await getMigrations()

  for (const migration of migrations) {
    const existing = await pool.query(
      "SELECT 1 FROM _migrations WHERE name = $1",
      [migration.name]
    )

    if (existing.rowCount === 0) {
      console.log(`[db] Running migration: ${migration.name}`)
      await pool.query(migration.up)
      await pool.query(
        "INSERT INTO _migrations (name) VALUES ($1)",
        [migration.name]
      )
      console.log(`[db] ✓ ${migration.name}`)
    }
  }

  console.log("[db] All migrations up to date.")
}

/**
 * Load all migration files in order.
 */
async function getMigrations() {
  const mods = [
    await import("./migrations/001_create_sessions.js"),
    await import("./migrations/002_create_run_actions.js"),
    await import("./migrations/003_create_users.js"),
    await import("./migrations/004_create_chats.js"),
    await import("./migrations/005_add_user_chat_to_sessions.js"),
    await import("./migrations/006_create_context_entries.js"),
    await import("./migrations/007_create_subscriptions.js"),
    await import("./migrations/008_create_usage_logs.js"),
    await import("./migrations/009_alter_subscriptions_numeric.js")
  ]
  return mods.map((m) => m.default)
}

export async function closeDatabase() {
  if (pool) {
    await pool.end()
    pool = null
  }
}
