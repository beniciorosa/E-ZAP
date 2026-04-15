-- ===== DHIEGO.AI — Persistent conversation history + system prompt =====
-- Phase 1 of the assistant was stateless: every message was answered in
-- isolation. This migration adds the conversation history table so the LLM
-- call can load the recent context, plus a new app_settings key for the
-- user-editable system prompt (admin panel edits it via /api/dhiego-ai/config).

CREATE TABLE IF NOT EXISTS dhiego_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES wa_sessions(id) ON DELETE CASCADE,
  chat_jid TEXT NOT NULL,
  sender_phone TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content TEXT NOT NULL,
  intent TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Hot query: "last N messages for this (user, session)"
CREATE INDEX IF NOT EXISTS idx_dhiego_conv_recent
  ON dhiego_conversations(user_id, session_id, created_at DESC);

ALTER TABLE dhiego_conversations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_all_dhiego_conv" ON dhiego_conversations;
CREATE POLICY "service_all_dhiego_conv" ON dhiego_conversations
  FOR ALL USING (true) WITH CHECK (true);

-- Default system prompt row (admin can edit via the DHIEGO.AI tab)
INSERT INTO app_settings (key, value) VALUES
  (
    'dhiego_ai_system_prompt',
    'Você é um assistente pessoal do Dhiego Rosa no WhatsApp. Responde de forma curta, direta, em português. Use emojis com moderação.'
  )
ON CONFLICT (key) DO NOTHING;
