-- Migration 027: Hidden chats
-- Allows users to hide specific conversations from the E-ZAP overlay.
-- Useful for ghost groups (user left but WhatsApp won't archive)
-- and any other conversation the user wants to remove from their view.

CREATE TABLE IF NOT EXISTS chat_hidden (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  jid TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, jid)
);

CREATE INDEX IF NOT EXISTS idx_chat_hidden_user ON chat_hidden(user_id);

ALTER TABLE chat_hidden ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own hidden chats"
  ON chat_hidden FOR ALL
  USING (true)
  WITH CHECK (true);
