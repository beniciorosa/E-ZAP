-- ===== Sync status RPC + index to kill grupos.html polling seq-scans =====
-- Before this migration grupos.html was firing 9 parallel COUNT queries per
-- connected session every 10s (~162 counts / 10s with 18 sessions). Only the
-- "pending" count was indexed (partial index). Every other count did a full
-- seq scan on wa_photo_queue / wa_contacts / wa_chats, saturating the
-- Supabase pooler and making admin.html login and ezapweb hang.
--
-- Fix = one RPC that returns per-session counts in ONE round-trip + composite
-- index on (session_id, status) so FILTER (WHERE status = X) uses the index.

-- 1. Composite index on wa_photo_queue(session_id, status) — covers all
--    status buckets (pending, downloading, done, failed, no_photo) in a
--    single index, replacing the partial-pending-only index effectively.
CREATE INDEX IF NOT EXISTS idx_wa_photo_queue_session_status
  ON wa_photo_queue(session_id, status);

-- 2. Partial index for wa_contacts "with photo" count
CREATE INDEX IF NOT EXISTS idx_wa_contacts_session_with_photo
  ON wa_contacts(session_id) WHERE photo_url IS NOT NULL;

-- 3. Partial index for wa_chats archived count
CREATE INDEX IF NOT EXISTS idx_wa_chats_session_archived
  ON wa_chats(session_id) WHERE archived = true;

-- 4. Batch RPC — returns every session's sync counters in a single query.
--    Uses LATERAL joins with FILTER aggregates, which run in ONE index scan
--    per session per table (versus the previous N * 9 HEAD requests).
CREATE OR REPLACE FUNCTION get_sync_status_all()
RETURNS TABLE (
  session_id UUID,
  total_contacts BIGINT,
  contacts_with_photo BIGINT,
  total_chats BIGINT,
  archived_chats BIGINT,
  q_pending BIGINT,
  q_downloading BIGINT,
  q_done BIGINT,
  q_failed BIGINT,
  q_no_photo BIGINT
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    s.id AS session_id,
    COALESCE(c.total, 0)        AS total_contacts,
    COALESCE(c.with_photo, 0)   AS contacts_with_photo,
    COALESCE(ch.total, 0)       AS total_chats,
    COALESCE(ch.archived, 0)    AS archived_chats,
    COALESCE(q.q_pending, 0)    AS q_pending,
    COALESCE(q.q_downloading, 0) AS q_downloading,
    COALESCE(q.q_done, 0)       AS q_done,
    COALESCE(q.q_failed, 0)     AS q_failed,
    COALESCE(q.q_no_photo, 0)   AS q_no_photo
  FROM wa_sessions s
  LEFT JOIN LATERAL (
    SELECT
      count(*)                                        AS total,
      count(*) FILTER (WHERE photo_url IS NOT NULL)   AS with_photo
    FROM wa_contacts WHERE session_id = s.id
  ) c ON TRUE
  LEFT JOIN LATERAL (
    SELECT
      count(*)                                AS total,
      count(*) FILTER (WHERE archived = TRUE) AS archived
    FROM wa_chats WHERE session_id = s.id
  ) ch ON TRUE
  LEFT JOIN LATERAL (
    SELECT
      count(*) FILTER (WHERE status = 'pending')     AS q_pending,
      count(*) FILTER (WHERE status = 'downloading') AS q_downloading,
      count(*) FILTER (WHERE status = 'done')        AS q_done,
      count(*) FILTER (WHERE status = 'failed')      AS q_failed,
      count(*) FILTER (WHERE status = 'no_photo')    AS q_no_photo
    FROM wa_photo_queue WHERE session_id = s.id
  ) q ON TRUE;
$$;

GRANT EXECUTE ON FUNCTION get_sync_status_all() TO service_role, anon, authenticated;
