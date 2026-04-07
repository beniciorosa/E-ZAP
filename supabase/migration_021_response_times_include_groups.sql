-- ===== fn_response_times: include group conversations =====
-- Previously filtered out groups (is_group = false), but 90%+ of client
-- conversations happen in groups. Now includes all conversations.
-- Added is_group field to by_chat results for UI differentiation.

CREATE OR REPLACE FUNCTION fn_response_times(
  p_user_id UUID DEFAULT NULL,
  p_date_from DATE DEFAULT (CURRENT_DATE - INTERVAL '30 days')::date,
  p_date_to DATE DEFAULT CURRENT_DATE
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  result JSON;
BEGIN
  WITH msg_pairs AS (
    SELECT
      m.chat_jid,
      m.is_group,
      m.timestamp AS received_at,
      (
        SELECT MIN(s.timestamp)
        FROM message_events s
        WHERE (p_user_id IS NULL OR s.user_id = p_user_id)
          AND s.chat_jid = m.chat_jid
          AND s.direction = 'sent'
          AND s.timestamp > m.timestamp
          AND s.timestamp < m.timestamp + INTERVAL '4 hours'
      ) AS responded_at
    FROM message_events m
    WHERE (p_user_id IS NULL OR m.user_id = p_user_id)
      AND m.direction = 'received'
      AND m.timestamp >= p_date_from
      AND m.timestamp < (p_date_to + INTERVAL '1 day')
      AND m.chat_jid IS NOT NULL
  ),
  response_data AS (
    SELECT
      chat_jid,
      BOOL_OR(COALESCE(is_group, false)) AS is_group,
      COUNT(*) AS total_received,
      COUNT(responded_at) AS total_responded,
      AVG(EXTRACT(EPOCH FROM (responded_at - received_at))) AS avg_response_seconds,
      PERCENTILE_CONT(0.5) WITHIN GROUP (
        ORDER BY EXTRACT(EPOCH FROM (responded_at - received_at))
      ) AS median_response_seconds
    FROM msg_pairs
    WHERE responded_at IS NOT NULL
    GROUP BY chat_jid
  )
  SELECT json_build_object(
    'overall', (
      SELECT json_build_object(
        'avg_response_seconds', COALESCE(ROUND(AVG(avg_response_seconds)), 0),
        'median_response_seconds', COALESCE(ROUND(AVG(median_response_seconds)), 0),
        'total_conversations', COUNT(*),
        'response_rate', COALESCE(
          ROUND(SUM(total_responded)::numeric / NULLIF(SUM(total_received), 0) * 100, 1),
          0
        )
      )
      FROM response_data
    ),
    'by_chat', (
      SELECT COALESCE(json_agg(json_build_object(
        'chat_jid', rd.chat_jid,
        'chat_name', me.chat_name,
        'is_group', rd.is_group,
        'avg_seconds', ROUND(rd.avg_response_seconds),
        'median_seconds', ROUND(rd.median_response_seconds),
        'responded', rd.total_responded,
        'received', rd.total_received
      ) ORDER BY rd.avg_response_seconds), '[]'::json)
      FROM response_data rd
      LEFT JOIN LATERAL (
        SELECT chat_name FROM message_events
        WHERE (p_user_id IS NULL OR user_id = p_user_id) AND chat_jid = rd.chat_jid AND chat_name IS NOT NULL
        ORDER BY timestamp DESC LIMIT 1
      ) me ON true
      LIMIT 30
    )
  ) INTO result;

  RETURN result;
END;
$$;

GRANT EXECUTE ON FUNCTION fn_response_times TO authenticated, service_role;
