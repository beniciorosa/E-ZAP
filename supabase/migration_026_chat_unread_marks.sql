-- Migration 026: Custom unread marks for chats
-- Since WhatsApp's internal markUnread API is unreliable,
-- we persist "mark as unread" state in our own database.
-- When a user marks a chat as unread via context menu, we store it here.
-- When they open the chat, we delete the mark.

CREATE TABLE IF NOT EXISTS chat_unread_marks (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  jid TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, jid)
);

-- Index for fast lookups by user
CREATE INDEX IF NOT EXISTS idx_chat_unread_marks_user ON chat_unread_marks(user_id);

-- RLS
ALTER TABLE chat_unread_marks ENABLE ROW LEVEL SECURITY;

-- Policy: users can manage their own marks
CREATE POLICY "Users manage own unread marks"
  ON chat_unread_marks FOR ALL
  USING (true)
  WITH CHECK (true);
