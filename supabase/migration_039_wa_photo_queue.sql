-- ===== wa_photo_queue: background photo download queue =====
CREATE TABLE IF NOT EXISTS wa_photo_queue (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES wa_sessions(id) ON DELETE CASCADE,
  jid TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','downloading','done','failed','no_photo')),
  attempts INTEGER DEFAULT 0,
  last_attempt_at TIMESTAMPTZ,
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(session_id, jid)
);

CREATE INDEX IF NOT EXISTS idx_wa_photo_queue_pending
  ON wa_photo_queue(session_id, status) WHERE status = 'pending';

-- RLS
ALTER TABLE wa_photo_queue ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_all_wa_photo_queue" ON wa_photo_queue FOR ALL USING (true) WITH CHECK (true);
