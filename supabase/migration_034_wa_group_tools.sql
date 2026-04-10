-- Migration 034: tables for the WhatsApp group tools (grupos.html)
-- Two tables:
--   wa_group_links: cache of invite links extracted for each (session, group)
--   wa_group_additions: history of bulk add operations (who added whom, to which group, status)

CREATE TABLE IF NOT EXISTS wa_group_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES wa_sessions(id) ON DELETE CASCADE,
  group_jid text NOT NULL,
  group_name text,
  invite_link text,
  invite_error text,
  is_admin boolean DEFAULT false,
  participants_count int DEFAULT 0,
  extracted_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  CONSTRAINT wa_group_links_session_group_unique UNIQUE (session_id, group_jid)
);

CREATE INDEX IF NOT EXISTS idx_wa_group_links_session ON wa_group_links(session_id);
CREATE INDEX IF NOT EXISTS idx_wa_group_links_has_link ON wa_group_links(session_id) WHERE invite_link IS NOT NULL;

-- Bulk add history: who added which phone to which group, when, with what result
CREATE TABLE IF NOT EXISTS wa_group_additions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_session_id uuid NOT NULL REFERENCES wa_sessions(id) ON DELETE CASCADE,
  target_phone text NOT NULL,
  group_jid text NOT NULL,
  group_name text,
  status text NOT NULL, -- added, added_and_promoted, already_member, already_admin, privacy_block, error, etc.
  status_message text,
  was_promoted boolean DEFAULT false,
  performed_at timestamptz DEFAULT now(),
  CONSTRAINT wa_group_additions_unique UNIQUE (source_session_id, target_phone, group_jid)
);

CREATE INDEX IF NOT EXISTS idx_wa_group_additions_session_phone
  ON wa_group_additions(source_session_id, target_phone);
CREATE INDEX IF NOT EXISTS idx_wa_group_additions_target_phone
  ON wa_group_additions(target_phone);
