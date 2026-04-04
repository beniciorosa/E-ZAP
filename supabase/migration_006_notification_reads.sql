-- Migration 006: Notification reads tracking
-- Adds notification support to global_messages + read tracking

-- 1. Add notification fields to global_messages
ALTER TABLE global_messages ADD COLUMN IF NOT EXISTS is_notification BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE global_messages ADD COLUMN IF NOT EXISTS notification_type TEXT DEFAULT 'info'; -- info, warning, success

-- 2. Create notification_reads table to track who viewed each notification
CREATE TABLE IF NOT EXISTS notification_reads (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  message_id UUID NOT NULL REFERENCES global_messages(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(message_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_notif_reads_message ON notification_reads(message_id);
CREATE INDEX IF NOT EXISTS idx_notif_reads_user ON notification_reads(user_id);

-- 3. RLS policies
ALTER TABLE notification_reads ENABLE ROW LEVEL SECURITY;

-- Everyone can read (needed for admin to see counts)
CREATE POLICY "notification_reads_select" ON notification_reads FOR SELECT USING (true);

-- Users can insert their own reads
CREATE POLICY "notification_reads_insert" ON notification_reads FOR INSERT WITH CHECK (true);
