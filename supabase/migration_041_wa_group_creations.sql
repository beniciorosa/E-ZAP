-- Migration 041: table for bulk group creation jobs (grupos.html create-groups feature)
-- Stores each row submitted via spreadsheet upload; the (session, spec_hash) unique
-- constraint lets the worker dedup re-submissions of the same file.

CREATE TABLE IF NOT EXISTS wa_group_creations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_session_id uuid NOT NULL REFERENCES wa_sessions(id) ON DELETE CASCADE,
  spec_hash text NOT NULL,
  group_name text NOT NULL,
  group_jid text,
  status text NOT NULL, -- pending, created, failed, rate_limited, cancelled
  status_message text,
  members_total int DEFAULT 0,
  members_added int DEFAULT 0,
  has_description boolean DEFAULT false,
  has_photo boolean DEFAULT false,
  locked boolean DEFAULT false,
  welcome_sent boolean DEFAULT false,
  invite_link text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  CONSTRAINT wa_group_creations_session_spec_unique UNIQUE (source_session_id, spec_hash)
);

CREATE INDEX IF NOT EXISTS idx_wa_group_creations_session
  ON wa_group_creations(source_session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wa_group_creations_status
  ON wa_group_creations(source_session_id, status);
