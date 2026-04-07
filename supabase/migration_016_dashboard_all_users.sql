-- =====================================================
-- Migration 016: Update dashboard functions to support all-users view
-- When p_user_id is NULL, show data for ALL users
-- =====================================================

-- ===== fn_dashboard_summary: support NULL user_id =====
CREATE OR REPLACE FUNCTION fn_dashboard_summary(
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
  SELECT json_build_object(
    'period', json_build_object('from', p_date_from, 'to', p_date_to),
    'totals', (
      SELECT json_build_object(
        'messages', COUNT(*),
        'sent', COUNT(*) FILTER (WHERE direction = 'sent'),
        'received', COUNT(*) FILTER (WHERE direction = 'received'),
        'unique_chats', COUNT(DISTINCT chat_jid),
        'unique_clients', COUNT(DISTINCT phone_client) FILTER (WHERE phone_client IS NOT NULL),
        'group_msgs', COUNT(*) FILTER (WHERE is_group = true),
        'individual_msgs', COUNT(*) FILTER (WHERE is_group = false OR is_group IS NULL),
        'audio_msgs', COUNT(*) FILTER (WHERE message_type = 'audio'),
        'transcribed', COUNT(*) FILTER (WHERE transcript IS NOT NULL AND transcript != ''),
        'avg_chars_per_msg', COALESCE(ROUND(AVG(char_count) FILTER (WHERE char_count > 0)), 0),
        'total_audio_minutes', COALESCE(ROUND(SUM(duration_seconds) FILTER (WHERE message_type = 'audio') / 60.0, 1), 0)
      )
      FROM message_events
      WHERE (p_user_id IS NULL OR user_id = p_user_id)
        AND timestamp >= p_date_from
        AND timestamp < (p_date_to + INTERVAL '1 day')
    ),
    'by_type', (
      SELECT COALESCE(json_agg(json_build_object('type', message_type, 'count', cnt)), '[]'::json)
      FROM (
        SELECT message_type, COUNT(*) AS cnt
        FROM message_events
        WHERE (p_user_id IS NULL OR user_id = p_user_id)
          AND timestamp >= p_date_from
          AND timestamp < (p_date_to + INTERVAL '1 day')
        GROUP BY message_type
        ORDER BY cnt DESC
      ) t
    ),
    'daily', (
      SELECT COALESCE(json_agg(json_build_object(
        'day', day,
        'sent', sent,
        'received', received,
        'total', total
      ) ORDER BY day), '[]'::json)
      FROM (
        SELECT
          date_trunc('day', timestamp)::date AS day,
          COUNT(*) FILTER (WHERE direction = 'sent') AS sent,
          COUNT(*) FILTER (WHERE direction = 'received') AS received,
          COUNT(*) AS total
        FROM message_events
        WHERE (p_user_id IS NULL OR user_id = p_user_id)
          AND timestamp >= p_date_from
          AND timestamp < (p_date_to + INTERVAL '1 day')
        GROUP BY date_trunc('day', timestamp)::date
      ) d
    ),
    'top_chats', (
      SELECT COALESCE(json_agg(json_build_object(
        'chat_jid', chat_jid,
        'chat_name', chat_name,
        'is_group', is_group,
        'total', total,
        'sent', sent,
        'received', received
      )), '[]'::json)
      FROM (
        SELECT
          chat_jid,
          MAX(chat_name) AS chat_name,
          BOOL_OR(is_group) AS is_group,
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE direction = 'sent') AS sent,
          COUNT(*) FILTER (WHERE direction = 'received') AS received
        FROM message_events
        WHERE (p_user_id IS NULL OR user_id = p_user_id)
          AND timestamp >= p_date_from
          AND timestamp < (p_date_to + INTERVAL '1 day')
          AND chat_jid IS NOT NULL
        GROUP BY chat_jid
        ORDER BY COUNT(*) DESC
        LIMIT 20
      ) tc
    ),
    'hourly', (
      SELECT COALESCE(json_agg(json_build_object(
        'hour', hour,
        'sent', sent,
        'received', received
      ) ORDER BY hour), '[]'::json)
      FROM (
        SELECT
          EXTRACT(HOUR FROM timestamp)::int AS hour,
          COUNT(*) FILTER (WHERE direction = 'sent') AS sent,
          COUNT(*) FILTER (WHERE direction = 'received') AS received
        FROM message_events
        WHERE (p_user_id IS NULL OR user_id = p_user_id)
          AND timestamp >= p_date_from
          AND timestamp < (p_date_to + INTERVAL '1 day')
        GROUP BY EXTRACT(HOUR FROM timestamp)::int
      ) h
    )
  ) INTO result;

  RETURN result;
END;
$$;

-- ===== fn_response_times: support NULL user_id =====
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
      AND (m.is_group = false OR m.is_group IS NULL)
      AND m.timestamp >= p_date_from
      AND m.timestamp < (p_date_to + INTERVAL '1 day')
      AND m.chat_jid IS NOT NULL
  ),
  response_data AS (
    SELECT
      chat_jid,
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

-- Re-apply grants
GRANT EXECUTE ON FUNCTION fn_dashboard_summary TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION fn_response_times TO authenticated, service_role;
