-- ===== wa_chats: add photo, description, group settings columns =====
ALTER TABLE wa_chats ADD COLUMN IF NOT EXISTS photo_url TEXT;
ALTER TABLE wa_chats ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE wa_chats ADD COLUMN IF NOT EXISTS participants_count INTEGER;
ALTER TABLE wa_chats ADD COLUMN IF NOT EXISTS is_read_only BOOLEAN DEFAULT false;
ALTER TABLE wa_chats ADD COLUMN IF NOT EXISTS ephemeral_duration INTEGER DEFAULT 0;
