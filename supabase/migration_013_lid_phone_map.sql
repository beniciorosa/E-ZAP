-- Migration 013: LID-to-Phone mapping table
-- WhatsApp Web now uses LIDs (Linked IDs) instead of phone numbers for group
-- participants. This table maps LIDs to real phone numbers for resolution.

CREATE TABLE IF NOT EXISTS lid_phone_map (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  lid TEXT NOT NULL,
  phone TEXT NOT NULL,
  contact_name TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(lid)
);

-- Index for fast lookup
CREATE INDEX IF NOT EXISTS idx_lid_phone_lid ON lid_phone_map(lid);
CREATE INDEX IF NOT EXISTS idx_lid_phone_phone ON lid_phone_map(phone);

-- Also fill user phone from allowed_phones where empty
UPDATE users
SET phone = REPLACE(allowed_phones[1], '+', '')
WHERE (phone IS NULL OR phone = '') AND allowed_phones IS NOT NULL AND array_length(allowed_phones, 1) > 0;

-- RLS: service role can do everything, authenticated can read
ALTER TABLE lid_phone_map ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access" ON lid_phone_map
  FOR ALL USING (true) WITH CHECK (true);
