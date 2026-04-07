-- =====================================================
-- Migration 011: Expand message_events for full message capture
-- Adds: message body, chat info, sender info, WA message ID (dedup),
--        transcript field for audio, media metadata, group flag
-- =====================================================

-- New columns for full message capture
ALTER TABLE message_events ADD COLUMN IF NOT EXISTS message_wid TEXT;
ALTER TABLE message_events ADD COLUMN IF NOT EXISTS chat_jid TEXT;
ALTER TABLE message_events ADD COLUMN IF NOT EXISTS chat_name TEXT;
ALTER TABLE message_events ADD COLUMN IF NOT EXISTS sender_name TEXT;
ALTER TABLE message_events ADD COLUMN IF NOT EXISTS body TEXT;
ALTER TABLE message_events ADD COLUMN IF NOT EXISTS transcript TEXT;
ALTER TABLE message_events ADD COLUMN IF NOT EXISTS caption TEXT;
ALTER TABLE message_events ADD COLUMN IF NOT EXISTS media_mime TEXT;
ALTER TABLE message_events ADD COLUMN IF NOT EXISTS duration_seconds INTEGER;
ALTER TABLE message_events ADD COLUMN IF NOT EXISTS is_group BOOLEAN DEFAULT false;
ALTER TABLE message_events ADD COLUMN IF NOT EXISTS group_participant TEXT;

-- Unique constraint on message_wid + user_id to prevent duplicates
-- (same message can be seen by different E-ZAP users in a group)
CREATE UNIQUE INDEX IF NOT EXISTS idx_msg_events_wid_user
  ON message_events(user_id, message_wid)
  WHERE message_wid IS NOT NULL;

-- Index for chat-level queries (all messages in a conversation)
CREATE INDEX IF NOT EXISTS idx_msg_events_chat
  ON message_events(user_id, chat_jid, timestamp);

-- Index for text search on body
CREATE INDEX IF NOT EXISTS idx_msg_events_body_trgm
  ON message_events USING gin (body gin_trgm_ops);

-- Make phone_mentor and phone_client nullable for legacy compat
-- (new capture may not always resolve phone numbers immediately)
ALTER TABLE message_events ALTER COLUMN phone_mentor DROP NOT NULL;
ALTER TABLE message_events ALTER COLUMN phone_client DROP NOT NULL;
