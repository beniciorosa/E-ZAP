-- ===== wa_chats: synced chat list from Baileys =====
CREATE TABLE IF NOT EXISTS wa_chats (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES wa_sessions(id) ON DELETE CASCADE,
  chat_jid TEXT NOT NULL,
  chat_name TEXT,
  unread_count INTEGER DEFAULT 0,
  is_group BOOLEAN DEFAULT false,
  last_message_timestamp TIMESTAMPTZ,
  pinned BOOLEAN DEFAULT false,
  archived BOOLEAN DEFAULT false,
  muted_until TIMESTAMPTZ,
  synced_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(session_id, chat_jid)
);

-- Index for quick lookups
CREATE INDEX IF NOT EXISTS idx_wa_chats_session ON wa_chats(session_id);
CREATE INDEX IF NOT EXISTS idx_wa_chats_session_ts ON wa_chats(session_id, last_message_timestamp DESC);

-- RLS
ALTER TABLE wa_chats ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all_wa_chats" ON wa_chats FOR ALL USING (true) WITH CHECK (true);
