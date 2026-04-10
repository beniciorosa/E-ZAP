-- =====================================================
-- Migration 033: WhatsApp Server tables
-- Backend multi-session support with Baileys
-- =====================================================

-- 1. Sessions table — one row per WhatsApp connection
CREATE TABLE IF NOT EXISTS wa_sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  phone TEXT,
  label TEXT NOT NULL DEFAULT 'WhatsApp',
  status TEXT NOT NULL DEFAULT 'disconnected'
    CHECK (status IN ('disconnected', 'qr_pending', 'connected', 'banned', 'error')),
  creds JSONB,
  last_seen TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wa_sessions_user ON wa_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_wa_sessions_status ON wa_sessions(status);
ALTER TABLE wa_sessions ENABLE ROW LEVEL SECURITY;

-- 2. Messages table — all messages received/sent via server
CREATE TABLE IF NOT EXISTS wa_messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID NOT NULL REFERENCES wa_sessions(id) ON DELETE CASCADE,
  message_id TEXT,
  chat_jid TEXT NOT NULL,
  chat_name TEXT,
  from_me BOOLEAN DEFAULT false,
  sender_name TEXT,
  sender_jid TEXT,
  body TEXT,
  media_type TEXT,
  media_url TEXT,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_messages_dedup
  ON wa_messages(session_id, message_id) WHERE message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_wa_messages_session_chat
  ON wa_messages(session_id, chat_jid, timestamp);
CREATE INDEX IF NOT EXISTS idx_wa_messages_timestamp
  ON wa_messages(session_id, timestamp);
ALTER TABLE wa_messages ENABLE ROW LEVEL SECURITY;

-- 3. Automations table — triggers and actions per session
CREATE TABLE IF NOT EXISTS wa_automations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID NOT NULL REFERENCES wa_sessions(id) ON DELETE CASCADE,
  trigger_type TEXT NOT NULL
    CHECK (trigger_type IN ('keyword', 'new_chat', 'schedule', 'webhook')),
  trigger_value TEXT,
  action_type TEXT NOT NULL
    CHECK (action_type IN ('reply', 'forward', 'notify', 'hubspot', 'api_call')),
  action_config JSONB NOT NULL DEFAULT '{}',
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wa_automations_session ON wa_automations(session_id);
ALTER TABLE wa_automations ENABLE ROW LEVEL SECURITY;
