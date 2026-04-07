-- =====================================================
-- Migration 015: Dashboard views, indices, and functions
-- Prepara a infraestrutura para o painel de performance
-- =====================================================

-- ===== ADDITIONAL INDICES =====
CREATE INDEX IF NOT EXISTS idx_msg_events_type_time
  ON message_events(user_id, message_type, timestamp);

CREATE INDEX IF NOT EXISTS idx_msg_events_group_time
  ON message_events(user_id, is_group, timestamp);

-- ===== VIEW: Daily Message Stats =====
CREATE OR REPLACE VIEW v_daily_message_stats AS
SELECT
  user_id,
  date_trunc('day', timestamp)::date AS day,
  COUNT(*) AS total_msgs,
  COUNT(*) FILTER (WHERE direction = 'sent') AS sent,
  COUNT(*) FILTER (WHERE direction = 'received') AS received,
  COUNT(*) FILTER (WHERE message_type = 'text') AS text_msgs,
  COUNT(*) FILTER (WHERE message_type = 'audio') AS audio_msgs,
  COUNT(*) FILTER (WHERE message_type = 'image') AS image_msgs,
  COUNT(*) FILTER (WHERE message_type = 'video') AS video_msgs,
  COUNT(*) FILTER (WHERE message_type NOT IN ('text','audio','image','video')) AS other_msgs,
  COUNT(DISTINCT chat_jid) AS unique_chats,
  COUNT(DISTINCT phone_client) FILTER (WHERE phone_client IS NOT NULL) AS unique_clients,
  ROUND(AVG(char_count) FILTER (WHERE char_count > 0)) AS avg_char_count,
  COUNT(*) FILTER (WHERE is_group = true) AS group_msgs,
  COUNT(*) FILTER (WHERE is_group = false OR is_group IS NULL) AS individual_msgs,
  COUNT(*) FILTER (WHERE message_type = 'audio' AND transcript IS NOT NULL AND transcript != '') AS transcribed_audios,
  COALESCE(SUM(duration_seconds) FILTER (WHERE message_type = 'audio' AND duration_seconds > 0), 0) AS total_audio_seconds
FROM message_events
GROUP BY user_id, date_trunc('day', timestamp)::date;

-- ===== VIEW: Chat Performance =====
CREATE OR REPLACE VIEW v_chat_performance AS
SELECT
  user_id,
  chat_jid,
  MAX(chat_name) AS chat_name,
  BOOL_OR(is_group) AS is_group,
  COUNT(*) AS total_msgs,
  COUNT(*) FILTER (WHERE direction = 'sent') AS sent,
  COUNT(*) FILTER (WHERE direction = 'received') AS received,
  MIN(timestamp) AS first_msg,
  MAX(timestamp) AS last_msg,
  COUNT(DISTINCT date_trunc('day', timestamp)::date) AS active_days,
  COUNT(*) FILTER (WHERE message_type = 'audio') AS audio_msgs,
  COALESCE(SUM(char_count) FILTER (WHERE direction = 'sent'), 0) AS total_chars_sent
FROM message_events
WHERE chat_jid IS NOT NULL
GROUP BY user_id, chat_jid;

-- ===== VIEW: Hourly Activity =====
CREATE OR REPLACE VIEW v_hourly_activity AS
SELECT
  user_id,
  EXTRACT(hour FROM timestamp)::int AS hour_of_day,
  COUNT(*) AS total_msgs,
  COUNT(*) FILTER (WHERE direction = 'sent') AS sent,
  COUNT(*) FILTER (WHERE direction = 'received') AS received
FROM message_events
GROUP BY user_id, EXTRACT(hour FROM timestamp)::int;

-- ===== VIEW: Message Type Breakdown (daily) =====
CREATE OR REPLACE VIEW v_message_type_stats AS
SELECT
  user_id,
  message_type,
  direction,
  COUNT(*) AS total,
  date_trunc('day', timestamp)::date AS day
FROM message_events
GROUP BY user_id, message_type, direction, date_trunc('day', timestamp)::date;

-- ===== FUNCTION: Dashboard Summary (all-in-one) =====
CREATE OR REPLACE FUNCTION fn_dashboard_summary(
  p_user_id UUID,
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
      WHERE user_id = p_user_id
        AND timestamp >= p_date_from
        AND timestamp < (p_date_to + INTERVAL '1 day')
    ),
    'by_type', (
      SELECT COALESCE(json_agg(json_build_object('type', message_type, 'count', cnt)), '[]'::json)
      FROM (
        SELECT message_type, COUNT(*) AS cnt
        FROM message_events
        WHERE user_id = p_user_id
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
        WHERE user_id = p_user_id
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
        WHERE user_id = p_user_id
          AND timestamp >= p_date_from
          AND timestamp < (p_date_to + INTERVAL '1 day')
          AND chat_jid IS NOT NULL
        GROUP BY chat_jid
        ORDER BY total DESC
        LIMIT 20
      ) tc
    ),
    'hourly', (
      SELECT COALESCE(json_agg(json_build_object(
        'hour', hour,
        'total', total,
        'sent', sent,
        'received', received
      ) ORDER BY hour), '[]'::json)
      FROM (
        SELECT
          EXTRACT(hour FROM timestamp)::int AS hour,
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE direction = 'sent') AS sent,
          COUNT(*) FILTER (WHERE direction = 'received') AS received
        FROM message_events
        WHERE user_id = p_user_id
          AND timestamp >= p_date_from
          AND timestamp < (p_date_to + INTERVAL '1 day')
        GROUP BY EXTRACT(hour FROM timestamp)::int
      ) h
    )
  ) INTO result;

  RETURN result;
END;
$$;

-- ===== FUNCTION: Response Times =====
CREATE OR REPLACE FUNCTION fn_response_times(
  p_user_id UUID,
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
        WHERE s.user_id = p_user_id
          AND s.chat_jid = m.chat_jid
          AND s.direction = 'sent'
          AND s.timestamp > m.timestamp
          AND s.timestamp < m.timestamp + INTERVAL '4 hours'
      ) AS responded_at
    FROM message_events m
    WHERE m.user_id = p_user_id
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
        WHERE user_id = p_user_id AND chat_jid = rd.chat_jid AND chat_name IS NOT NULL
        ORDER BY timestamp DESC LIMIT 1
      ) me ON true
      LIMIT 30
    )
  ) INTO result;

  RETURN result;
END;
$$;

-- ===== FUNCTION: Admin overview (all users) =====
CREATE OR REPLACE FUNCTION fn_admin_overview(
  p_date_from DATE DEFAULT (CURRENT_DATE - INTERVAL '7 days')::date,
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
    'users', (
      SELECT COALESCE(json_agg(json_build_object(
        'user_id', user_id,
        'name', name,
        'phone', phone,
        'total_msgs', total_msgs,
        'sent', sent,
        'received', received,
        'unique_chats', unique_chats,
        'last_activity', last_activity
      ) ORDER BY total_msgs DESC), '[]'::json)
      FROM (
        SELECT
          u.id AS user_id,
          u.name,
          u.phone,
          COUNT(me.*) AS total_msgs,
          COUNT(*) FILTER (WHERE me.direction = 'sent') AS sent,
          COUNT(*) FILTER (WHERE me.direction = 'received') AS received,
          COUNT(DISTINCT me.chat_jid) AS unique_chats,
          MAX(me.timestamp) AS last_activity
        FROM users u
        LEFT JOIN message_events me ON me.user_id = u.id
          AND me.timestamp >= p_date_from
          AND me.timestamp < (p_date_to + INTERVAL '1 day')
        WHERE u.status = 'active'
        GROUP BY u.id, u.name, u.phone
      ) user_stats
    ),
    'totals', (
      SELECT json_build_object(
        'messages', COUNT(*),
        'active_users', COUNT(DISTINCT user_id),
        'unique_chats', COUNT(DISTINCT chat_jid),
        'audio_msgs', COUNT(*) FILTER (WHERE message_type = 'audio'),
        'transcribed', COUNT(*) FILTER (WHERE transcript IS NOT NULL AND transcript != '')
      )
      FROM message_events
      WHERE timestamp >= p_date_from
        AND timestamp < (p_date_to + INTERVAL '1 day')
    )
  ) INTO result;

  RETURN result;
END;
$$;

-- ===== GRANTS =====
GRANT SELECT ON v_daily_message_stats TO authenticated, service_role;
GRANT SELECT ON v_chat_performance TO authenticated, service_role;
GRANT SELECT ON v_hourly_activity TO authenticated, service_role;
GRANT SELECT ON v_message_type_stats TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION fn_dashboard_summary TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION fn_response_times TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION fn_admin_overview TO service_role;
