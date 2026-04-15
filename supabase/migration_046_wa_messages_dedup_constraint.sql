-- ===== Upgrade idx_wa_messages_dedup to a CONSTRAINT =====
-- Background: migration 045 dropped the partial unique index and recreated it
-- as a regular UNIQUE INDEX on (session_id, message_id). That fixed the partial
-- index issue but left a subtler problem in place: PostgREST's
-- `?on_conflict=session_id,message_id` query parameter requires a UNIQUE (or
-- exclusion) CONSTRAINT, not just a unique index. With only the index present,
-- Postgres responds with 42P10 "there is no unique or exclusion constraint
-- matching the ON CONFLICT specification" and rejects every upsert attempt.
--
-- Symptoms observed on 2026-04-15 early afternoon:
--   - 1634 occurrences of 42P10 in the last ~5000 PM2 log lines
--   - 925 "[BAILEYS] Message handler error" lines from wa_messages upserts
--   - DHIEGO.AI hook never reached (exception thrown before it in handleIncomingMessage)
--   - ezapweb losing persistence silently across all 19 sessions
--
-- Fix: attach the existing unique index as a UNIQUE constraint via
-- `ALTER TABLE ... ADD CONSTRAINT ... UNIQUE USING INDEX ...`. This preserves
-- the index (no data rescan), takes a brief ACCESS EXCLUSIVE lock, and
-- immediately makes on_conflict=session_id,message_id work again.

ALTER TABLE wa_messages
  ADD CONSTRAINT wa_messages_dedup UNIQUE USING INDEX idx_wa_messages_dedup;
