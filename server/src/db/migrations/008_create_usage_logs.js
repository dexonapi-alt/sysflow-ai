export default {
  name: "008_create_usage_logs",
  up: `
    CREATE TABLE IF NOT EXISTS usage_logs (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL,
      project_id TEXT,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cost_cents NUMERIC(10, 4) NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_usage_logs_user_id ON usage_logs (user_id);
    CREATE INDEX IF NOT EXISTS idx_usage_logs_created_at ON usage_logs (created_at);

    ALTER TABLE users ADD COLUMN IF NOT EXISTS free_prompts_today INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS free_prompts_reset_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
  `
}
