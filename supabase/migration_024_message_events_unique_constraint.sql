-- Add full unique constraint on (user_id, message_wid) for PostgREST ON CONFLICT to work
-- The existing idx_msg_events_wid_user is partial (WHERE message_wid IS NOT NULL)
-- which PostgREST cannot use for upsert/ignore-duplicates
CREATE UNIQUE INDEX IF NOT EXISTS message_events_user_wid_uniq
  ON message_events (user_id, message_wid);
