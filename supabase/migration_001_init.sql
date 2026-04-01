-- =====================================================
-- WhatsApp CRM - Supabase Migration 001 - Initial Setup
-- =====================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =====================================================
-- 1. USERS TABLE (gestão de usuários e autenticação por token)
-- =====================================================
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  email TEXT UNIQUE,
  phone TEXT,
  token TEXT UNIQUE NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_active TIMESTAMPTZ
);

-- Index for token lookup (used on every extension login)
CREATE INDEX IF NOT EXISTS idx_users_token ON users(token);

-- =====================================================
-- 2. ABAS (tab groups per user)
-- =====================================================
CREATE TABLE IF NOT EXISTS abas (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#cc5de8',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_abas_user ON abas(user_id);

-- =====================================================
-- 3. ABA_CONTACTS (contacts within each tab)
-- =====================================================
CREATE TABLE IF NOT EXISTS aba_contacts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  aba_id UUID NOT NULL REFERENCES abas(id) ON DELETE CASCADE,
  contact_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(aba_id, contact_name)
);

CREATE INDEX IF NOT EXISTS idx_aba_contacts_aba ON aba_contacts(aba_id);

-- =====================================================
-- 4. PINNED_CONTACTS (contacts pinned by each user)
-- =====================================================
CREATE TABLE IF NOT EXISTS pinned_contacts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, contact_name)
);

CREATE INDEX IF NOT EXISTS idx_pinned_user ON pinned_contacts(user_id);

-- =====================================================
-- 5. LABELS (colored labels per contact, per user)
-- =====================================================
CREATE TABLE IF NOT EXISTS labels (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_phone TEXT NOT NULL,
  contact_name TEXT,
  color TEXT NOT NULL,
  text TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_labels_user ON labels(user_id);
CREATE INDEX IF NOT EXISTS idx_labels_contact ON labels(user_id, contact_phone);

-- =====================================================
-- 6. OBSERVATIONS (rich text notes per contact, per user)
-- =====================================================
CREATE TABLE IF NOT EXISTS observations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_phone TEXT NOT NULL,
  contact_name TEXT,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_observations_user ON observations(user_id);
CREATE INDEX IF NOT EXISTS idx_observations_contact ON observations(user_id, contact_phone);

-- =====================================================
-- 7. MSG_SEQUENCES (automated message sequences)
-- =====================================================
CREATE TABLE IF NOT EXISTS msg_sequences (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_phone TEXT NOT NULL,
  contact_name TEXT,
  messages JSONB NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'completed', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_msg_seq_user ON msg_sequences(user_id);
CREATE INDEX IF NOT EXISTS idx_msg_seq_status ON msg_sequences(user_id, status);

-- =====================================================
-- 8. GLOBAL_MESSAGES (admin creates, everyone sees)
-- =====================================================
CREATE TABLE IF NOT EXISTS global_messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  category TEXT,
  attachments JSONB DEFAULT '[]',
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE SET NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =====================================================
-- 9. USER_MESSAGES (personal message templates per user)
-- =====================================================
CREATE TABLE IF NOT EXISTS user_messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  category TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_messages_user ON user_messages(user_id);

-- =====================================================
-- 10. MESSAGE_EVENTS (productivity tracking - SLA, volume, etc.)
-- =====================================================
CREATE TABLE IF NOT EXISTS message_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  phone_mentor TEXT NOT NULL,
  phone_client TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('sent', 'received')),
  message_type TEXT NOT NULL DEFAULT 'text' CHECK (message_type IN ('text', 'audio', 'image', 'video', 'document', 'sticker', 'contact', 'location', 'other')),
  char_count INTEGER DEFAULT 0,
  is_question BOOLEAN DEFAULT false,
  is_closing BOOLEAN DEFAULT false,
  response_time_seconds INTEGER,
  used_template BOOLEAN DEFAULT false,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_msg_events_user ON message_events(user_id);
CREATE INDEX IF NOT EXISTS idx_msg_events_user_time ON message_events(user_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_msg_events_client ON message_events(user_id, phone_client);
CREATE INDEX IF NOT EXISTS idx_msg_events_direction ON message_events(user_id, direction, timestamp);

-- =====================================================
-- 11. DOCUMENTS (PDFs and files stored in Supabase Storage)
-- =====================================================
CREATE TABLE IF NOT EXISTS documents (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_phone TEXT,
  contact_name TEXT,
  filename TEXT NOT NULL,
  file_path TEXT NOT NULL,
  file_size BIGINT DEFAULT 0,
  mime_type TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_documents_user ON documents(user_id);
CREATE INDEX IF NOT EXISTS idx_documents_contact ON documents(user_id, contact_phone);

-- =====================================================
-- 12. USER_ACTIVITY (daily activity summary for dashboards)
-- =====================================================
CREATE TABLE IF NOT EXISTS user_activity (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  activity_date DATE NOT NULL DEFAULT CURRENT_DATE,
  messages_sent INTEGER DEFAULT 0,
  messages_received INTEGER DEFAULT 0,
  unique_contacts INTEGER DEFAULT 0,
  avg_response_time_seconds INTEGER,
  max_response_time_seconds INTEGER,
  sla_met_count INTEGER DEFAULT 0,
  sla_missed_count INTEGER DEFAULT 0,
  first_activity TIMESTAMPTZ,
  last_activity TIMESTAMPTZ,
  templates_used INTEGER DEFAULT 0,
  observations_created INTEGER DEFAULT 0,
  UNIQUE(user_id, activity_date)
);

CREATE INDEX IF NOT EXISTS idx_user_activity_user_date ON user_activity(user_id, activity_date);

-- =====================================================
-- 13. USER_USAGE (storage consumption tracking)
-- =====================================================
CREATE TABLE IF NOT EXISTS user_usage (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  storage_bytes BIGINT DEFAULT 0,
  total_events INTEGER DEFAULT 0,
  total_documents INTEGER DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =====================================================
-- ROW LEVEL SECURITY (RLS) POLICIES
-- Each user can only access their own data
-- Admin can access everything
-- =====================================================

-- Enable RLS on all tables
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE abas ENABLE ROW LEVEL SECURITY;
ALTER TABLE aba_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE pinned_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE labels ENABLE ROW LEVEL SECURITY;
ALTER TABLE observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE msg_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE global_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_usage ENABLE ROW LEVEL SECURITY;

-- Service role bypasses RLS automatically, so the extension
-- (using service role key) can read/write all data.
-- These policies are for when using anon key + JWT auth in the future.

-- Global messages: everyone can read, only admins can write
CREATE POLICY "global_messages_read" ON global_messages FOR SELECT USING (true);
CREATE POLICY "global_messages_admin_write" ON global_messages FOR ALL USING (
  EXISTS (SELECT 1 FROM users WHERE id = created_by AND role = 'admin')
);

-- =====================================================
-- SEED: Create admin user (Diego Rosa)
-- =====================================================
INSERT INTO users (name, email, phone, token, role)
VALUES (
  'Diego Rosa',
  'admin@wcrm.com',
  '',
  'WCRM-ADMIN-' || substr(md5(random()::text), 1, 8),
  'admin'
)
ON CONFLICT (email) DO NOTHING;

-- =====================================================
-- HELPER FUNCTION: Validate token and return user
-- =====================================================
CREATE OR REPLACE FUNCTION validate_token(p_token TEXT)
RETURNS TABLE(
  user_id UUID,
  user_name TEXT,
  user_email TEXT,
  user_phone TEXT,
  user_role TEXT
) AS $$
BEGIN
  -- Update last_active
  UPDATE users SET last_active = now() WHERE token = p_token AND active = true;

  RETURN QUERY
  SELECT id, name, email, phone, role
  FROM users
  WHERE token = p_token AND active = true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =====================================================
-- HELPER FUNCTION: Generate unique token
-- =====================================================
CREATE OR REPLACE FUNCTION generate_token()
RETURNS TEXT AS $$
DECLARE
  new_token TEXT;
  token_exists BOOLEAN;
BEGIN
  LOOP
    new_token := 'WCRM-' ||
      upper(substr(md5(random()::text), 1, 4)) || '-' ||
      upper(substr(md5(random()::text), 1, 4)) || '-' ||
      upper(substr(md5(random()::text), 1, 4));

    SELECT EXISTS(SELECT 1 FROM users WHERE token = new_token) INTO token_exists;
    EXIT WHEN NOT token_exists;
  END LOOP;

  RETURN new_token;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =====================================================
-- HELPER FUNCTION: Get daily stats for a user
-- =====================================================
CREATE OR REPLACE FUNCTION get_user_daily_stats(p_user_id UUID, p_date DATE DEFAULT CURRENT_DATE)
RETURNS TABLE(
  total_sent BIGINT,
  total_received BIGINT,
  unique_contacts BIGINT,
  avg_response_seconds NUMERIC,
  max_response_seconds INTEGER,
  sla_met BIGINT,
  sla_missed BIGINT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    COUNT(*) FILTER (WHERE direction = 'sent'),
    COUNT(*) FILTER (WHERE direction = 'received'),
    COUNT(DISTINCT phone_client),
    AVG(response_time_seconds) FILTER (WHERE response_time_seconds IS NOT NULL),
    MAX(response_time_seconds),
    COUNT(*) FILTER (WHERE response_time_seconds IS NOT NULL AND response_time_seconds <= 900),
    COUNT(*) FILTER (WHERE response_time_seconds IS NOT NULL AND response_time_seconds > 900)
  FROM message_events
  WHERE user_id = p_user_id
    AND timestamp::date = p_date;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =====================================================
-- HELPER FUNCTION: Get team overview (admin only)
-- =====================================================
CREATE OR REPLACE FUNCTION get_team_overview(p_date DATE DEFAULT CURRENT_DATE)
RETURNS TABLE(
  user_id UUID,
  user_name TEXT,
  total_sent BIGINT,
  total_received BIGINT,
  unique_contacts BIGINT,
  avg_response_seconds NUMERIC,
  max_response_seconds INTEGER,
  sla_percentage NUMERIC
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    u.id,
    u.name,
    COUNT(*) FILTER (WHERE me.direction = 'sent'),
    COUNT(*) FILTER (WHERE me.direction = 'received'),
    COUNT(DISTINCT me.phone_client),
    AVG(me.response_time_seconds) FILTER (WHERE me.response_time_seconds IS NOT NULL),
    MAX(me.response_time_seconds),
    CASE
      WHEN COUNT(*) FILTER (WHERE me.response_time_seconds IS NOT NULL) = 0 THEN 100.0
      ELSE ROUND(
        100.0 * COUNT(*) FILTER (WHERE me.response_time_seconds IS NOT NULL AND me.response_time_seconds <= 900) /
        NULLIF(COUNT(*) FILTER (WHERE me.response_time_seconds IS NOT NULL), 0),
        1
      )
    END
  FROM users u
  LEFT JOIN message_events me ON me.user_id = u.id AND me.timestamp::date = p_date
  WHERE u.active = true AND u.role = 'user'
  GROUP BY u.id, u.name
  ORDER BY u.name;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
