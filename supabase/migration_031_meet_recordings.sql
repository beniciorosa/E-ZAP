-- =====================================================
-- Migration 031: Create meet_recordings table
-- Logs auto-recording events from Google Meet
-- =====================================================

CREATE TABLE IF NOT EXISTS meet_recordings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  meet_url TEXT NOT NULL,
  meeting_title TEXT,
  event_type TEXT NOT NULL CHECK (event_type IN ('recording_started', 'meeting_ended')),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  duration_seconds INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for user queries
CREATE INDEX IF NOT EXISTS idx_meet_recordings_user
  ON meet_recordings(user_id);

-- Index for event type + time queries (dashboard/reports)
CREATE INDEX IF NOT EXISTS idx_meet_recordings_event_time
  ON meet_recordings(event_type, recorded_at);

-- Enable RLS (service key bypasses automatically)
ALTER TABLE meet_recordings ENABLE ROW LEVEL SECURITY;
