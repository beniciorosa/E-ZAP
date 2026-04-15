-- Migration 048: DHIEGO.AI active task state
--
-- Persists the assistant's active task per (user, session, chat) so short
-- follow-ups like "manda atualizado" or "atualiza para isso" can be resolved
-- against the current working context instead of depending only on recent text.

CREATE TABLE IF NOT EXISTS dhiego_ai_state (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES wa_sessions(id) ON DELETE CASCADE,
  chat_jid TEXT NOT NULL,
  active_task TEXT,
  active_tool TEXT,
  focus_idea_id INTEGER,
  state_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '12 hours')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_dhiego_ai_state_scope
  ON dhiego_ai_state(user_id, session_id, chat_jid);

CREATE INDEX IF NOT EXISTS idx_dhiego_ai_state_recent
  ON dhiego_ai_state(user_id, session_id, updated_at DESC);

ALTER TABLE dhiego_ai_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_all_dhiego_ai_state" ON dhiego_ai_state;
CREATE POLICY "service_all_dhiego_ai_state" ON dhiego_ai_state
  FOR ALL USING (true) WITH CHECK (true);
