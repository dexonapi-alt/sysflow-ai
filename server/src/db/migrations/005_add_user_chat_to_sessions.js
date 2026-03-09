export default {
  name: "005_add_user_chat_to_sessions",
  up: `
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id);
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS chat_id INTEGER REFERENCES chats(id);
    ALTER TABLE run_actions ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id);
    ALTER TABLE run_actions ADD COLUMN IF NOT EXISTS chat_id INTEGER REFERENCES chats(id);

    CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions (user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_chat_id ON sessions (chat_id);
    CREATE INDEX IF NOT EXISTS idx_run_actions_chat_id ON run_actions (chat_id);
  `
}
