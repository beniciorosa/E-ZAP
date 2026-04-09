-- Add chat_name to message_notes for easy dot indicator queries
-- Without this, we'd need to resolve JID->name at runtime (unreliable)

ALTER TABLE message_notes ADD COLUMN IF NOT EXISTS chat_name TEXT;

CREATE INDEX IF NOT EXISTS idx_message_notes_chat_name
  ON message_notes (user_id, chat_name)
  WHERE chat_name IS NOT NULL;
