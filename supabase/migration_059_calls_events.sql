-- Migration 059: calls_events
-- Armazena metadados de meetings do HubSpot (titulo, horario, contato) pra
-- alimentar o widget CALLS do sidebar da extensao (HOJE / AMANHA / SEMANA).
--
-- 1 meeting pode ter N contatos associados -> 1 row por (meeting_id, phone).
-- primary_jid e o chat preferido pra abrir (prioridade grupo > dm > lid).

CREATE TABLE IF NOT EXISTS calls_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id TEXT NOT NULL,
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ,
  title TEXT,
  phone TEXT NOT NULL,
  primary_jid TEXT,
  jid_type TEXT,
  contact_name TEXT,
  owner_id TEXT,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT calls_events_meeting_phone_unique UNIQUE (meeting_id, phone)
);

CREATE INDEX IF NOT EXISTS idx_calls_events_start ON calls_events(start_time);
CREATE INDEX IF NOT EXISTS idx_calls_events_phone ON calls_events(phone);
CREATE INDEX IF NOT EXISTS idx_calls_events_jid ON calls_events(primary_jid);
