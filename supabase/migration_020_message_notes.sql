-- ===== message_notes: private user annotations on messages =====
CREATE TABLE IF NOT EXISTS message_notes (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  message_wid TEXT NOT NULL,
  chat_jid TEXT,
  note_text TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, message_wid)
);

CREATE INDEX IF NOT EXISTS idx_message_notes_user_chat ON message_notes(user_id, chat_jid);

ALTER TABLE message_notes ENABLE ROW LEVEL SECURITY;

-- Users can only see their own notes
CREATE POLICY "Users see own notes" ON message_notes
  FOR ALL USING (user_id = auth.uid());

-- Service role has full access
CREATE POLICY "Service role full access" ON message_notes
  FOR ALL USING (true)
  WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON message_notes TO authenticated, service_role;
