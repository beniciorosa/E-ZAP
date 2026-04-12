-- ===== wa_messages: add status tracking, edit/delete, reactions =====
ALTER TABLE wa_messages ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'sent';
ALTER TABLE wa_messages ADD COLUMN IF NOT EXISTS is_edited BOOLEAN DEFAULT false;
ALTER TABLE wa_messages ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT false;
ALTER TABLE wa_messages ADD COLUMN IF NOT EXISTS reactions JSONB DEFAULT '[]'::jsonb;
ALTER TABLE wa_messages ADD COLUMN IF NOT EXISTS edit_timestamp TIMESTAMPTZ;
