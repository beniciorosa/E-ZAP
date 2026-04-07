-- Migration 012: Fix message_events for proper upsert support
-- The partial unique index (WHERE message_wid IS NOT NULL) doesn't work with
-- PostgREST's on_conflict. Replace with a proper UNIQUE CONSTRAINT.

-- 1. Drop the partial unique index
DROP INDEX IF EXISTS idx_msg_events_wid_user;

-- 2. Make message_wid NOT NULL (all existing data already has values)
ALTER TABLE message_events ALTER COLUMN message_wid SET NOT NULL;

-- 3. Create a proper UNIQUE CONSTRAINT (required for PostgREST merge-duplicates)
ALTER TABLE message_events ADD CONSTRAINT uq_msg_events_user_wid UNIQUE (user_id, message_wid);

-- 4. Fix phone_client for group chats: set to null where it contains group JID
UPDATE message_events
SET phone_client = NULL
WHERE is_group = true AND phone_client IS NOT NULL AND LENGTH(phone_client) > 15;
