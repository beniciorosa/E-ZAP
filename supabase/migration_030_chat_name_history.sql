-- Track chat/group name changes over time
-- Keeps history of all name changes with old and new values

CREATE TABLE IF NOT EXISTS chat_name_history (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  chat_jid TEXT NOT NULL,
  old_name TEXT,
  new_name TEXT NOT NULL,
  changed_at TIMESTAMPTZ DEFAULT now(),
  detected_by UUID REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_chat_name_history_jid ON chat_name_history (chat_jid, changed_at DESC);

ALTER TABLE chat_name_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY "chat_name_history_all" ON chat_name_history FOR ALL USING (true) WITH CHECK (true);
