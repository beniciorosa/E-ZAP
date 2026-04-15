-- Migration 043: DHIEGO.AI personal WhatsApp assistant
--
-- Creates the dhiego_ideas backlog table + default config rows in app_settings.
-- The claude_api_key is NOT stored here — it's injected separately via a
-- one-shot SQL run through the Supabase Management API during deploy, so the
-- secret never enters git history.
--
-- The assistant listens on a specific wa_session (configured via
-- app_settings.dhiego_ai_session_id) and only responds when the incoming
-- message is either from the session itself (fromMe) OR from a phone number
-- listed in app_settings.dhiego_ai_authorized_phones. Admin panel at
-- admin.html #panel-dhiego-ai lets the admin toggle enabled, set the session,
-- manage the allowlist, and browse ideas.

-- ===== 1. dhiego_ideas table =====
-- Uses SERIAL id so the user can reference ideas by small number in commands
-- like "completei a ideia 5" or "deleta ideia 3". Small integers are much
-- easier to type on WhatsApp than UUIDs.
CREATE TABLE IF NOT EXISTS dhiego_ideas (
  id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id UUID REFERENCES wa_sessions(id) ON DELETE SET NULL,
  text TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'text',  -- 'text' | 'audio' | 'windows_tool' | 'admin'
  source_message_id TEXT,
  status TEXT NOT NULL DEFAULT 'open',  -- 'open' | 'done' | 'cancelled'
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_dhiego_ideas_user_status ON dhiego_ideas(user_id, status);
CREATE INDEX IF NOT EXISTS idx_dhiego_ideas_created_at ON dhiego_ideas(created_at DESC);

-- ===== 2. Default app_settings rows for DHIEGO.AI =====
-- Only inserts if the key doesn't exist yet (ON CONFLICT DO NOTHING) so re-
-- running the migration is safe and never overwrites admin-panel changes.
INSERT INTO app_settings (key, value) VALUES
  ('dhiego_ai_enabled', 'false'),
  ('dhiego_ai_session_id', 'd9f39bb5-5f3e-4bf3-8d47-9944c9cf78ff'),
  ('dhiego_ai_authorized_phones', '[]'),
  ('dhiego_ai_llm_model', 'claude-haiku-4-5-20251001')
ON CONFLICT (key) DO NOTHING;

-- ===== 3. Link the DHIEGO.AI session to Dhiego's user record =====
-- Only updates if user_id is currently NULL, so it won't clobber a future
-- manual assignment.
UPDATE wa_sessions
SET user_id = '58db56f3-f84e-43b2-bbb2-17af8f52b9b8'
WHERE id = 'd9f39bb5-5f3e-4bf3-8d47-9944c9cf78ff'
  AND user_id IS NULL;
