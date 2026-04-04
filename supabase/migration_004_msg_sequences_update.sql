-- Migration 004: Update msg_sequences for template-style sequences + labels sync
-- Run this in Supabase SQL Editor
-- E-ZAP v1.3.1

-- =============================================
-- 1. msg_sequences: Add name column (sequence title)
-- =============================================
ALTER TABLE msg_sequences ADD COLUMN IF NOT EXISTS name TEXT DEFAULT '';

-- =============================================
-- 2. msg_sequences: Make contact_phone optional
-- (sequences are reusable templates, not tied to a specific contact)
-- =============================================
ALTER TABLE msg_sequences ALTER COLUMN contact_phone DROP NOT NULL;
ALTER TABLE msg_sequences ALTER COLUMN contact_phone SET DEFAULT '';

-- =============================================
-- 3. msg_sequences: Add schedule and sent columns
-- =============================================
ALTER TABLE msg_sequences ADD COLUMN IF NOT EXISTS schedule TIMESTAMPTZ;
ALTER TABLE msg_sequences ADD COLUMN IF NOT EXISTS sent BOOLEAN DEFAULT FALSE;

-- =============================================
-- 4. Verify labels table has proper indexes
-- (table already exists from migration_001)
-- =============================================
CREATE INDEX IF NOT EXISTS idx_labels_user_phone ON labels(user_id, contact_phone);
