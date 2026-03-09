export default {
  name: "004_create_chats",
  up: `
    CREATE TABLE IF NOT EXISTS chats (
      id SERIAL PRIMARY KEY,
      chat_uid TEXT NOT NULL UNIQUE DEFAULT gen_random_uuid()::text,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT 'New Chat',
      model TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_chats_user_id ON chats (user_id);
    CREATE INDEX IF NOT EXISTS idx_chats_project_id ON chats (project_id);
    CREATE INDEX IF NOT EXISTS idx_chats_chat_uid ON chats (chat_uid);
  `
}
