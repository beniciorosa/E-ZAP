-- Fix fn_admin_overview: use allowed_phones[1] as fallback when phone is NULL
CREATE OR REPLACE FUNCTION public.fn_admin_overview(
  p_date_from date DEFAULT (CURRENT_DATE - INTERVAL '7 days')::date,
  p_date_to date DEFAULT CURRENT_DATE
)
RETURNS json
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
          COALESCE(u.phone, u.allowed_phones[1]) AS phone,
          COUNT(me.*) AS total_msgs,
          COUNT(*) FILTER (WHERE me.direction = 'sent') AS sent,
          COUNT(*) FILTER (WHERE me.direction = 'received') AS received,
          COUNT(DISTINCT me.chat_jid) AS unique_chats,
          MAX(me.timestamp) AS last_activity
        FROM users u
        LEFT JOIN message_events me ON me.user_id = u.id
          AND me.timestamp >= p_date_from
          AND me.timestamp < (p_date_to + INTERVAL '1 day')
        WHERE u.active = true
        GROUP BY u.id, u.name, u.phone, u.allowed_phones
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
