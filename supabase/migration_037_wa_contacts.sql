-- ===== wa_contacts: persistent contact storage from Baileys =====
CREATE TABLE IF NOT EXISTS wa_contacts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES wa_sessions(id) ON DELETE CASCADE,
  contact_jid TEXT NOT NULL,
  name TEXT,
  push_name TEXT,
  phone TEXT,
  is_group BOOLEAN DEFAULT false,
  is_business BOOLEAN DEFAULT false,
  photo_url TEXT,
  photo_updated_at TIMESTAMPTZ,
  synced_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(session_id, contact_jid)
);

CREATE INDEX IF NOT EXISTS idx_wa_contacts_session ON wa_contacts(session_id);
CREATE INDEX IF NOT EXISTS idx_wa_contacts_phone ON wa_contacts(session_id, phone);

-- RLS
ALTER TABLE wa_contacts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_all_wa_contacts" ON wa_contacts FOR ALL USING (true) WITH CHECK (true);
