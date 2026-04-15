-- ===== Fix wa_messages dedup index for PostgREST ON CONFLICT =====
-- Background: idx_wa_messages_dedup was originally defined as a PARTIAL unique
-- index with `WHERE (message_id IS NOT NULL)`. PostgREST's `?on_conflict=...`
-- query parameter cannot target partial indexes — Postgres rejects with
-- error 42P10 "there is no unique or exclusion constraint matching the ON
-- CONFLICT specification". Result after commit 5211bf7 added on_conflict to
-- the wa_messages upserts: every single insert from baileys returned a 400
-- and no message persisted, which silently broke ezapweb and DHIEGO.AI's
-- ability to even *see* incoming messages.
--
-- Fix: drop the partial index and recreate as a regular UNIQUE index. We
-- already verified zero rows have NULL message_id, and PostgreSQL UNIQUE
-- treats NULLs as distinct anyway, so behavior is unchanged for any future
-- legacy NULL inserts.

DROP INDEX IF EXISTS idx_wa_messages_dedup;

CREATE UNIQUE INDEX idx_wa_messages_dedup
  ON wa_messages(session_id, message_id);
