-- Migration 014: Add transcription_status column for automatic audio transcription
-- Status: null (not audio / not applicable), 'pending', 'done', 'error', 'skipped'

ALTER TABLE message_events ADD COLUMN IF NOT EXISTS transcription_status TEXT;

-- Index for finding untranscribed audio messages efficiently
CREATE INDEX IF NOT EXISTS idx_msg_events_transcription_pending
  ON message_events(user_id, transcription_status)
  WHERE message_type = 'audio' AND transcription_status = 'pending';
