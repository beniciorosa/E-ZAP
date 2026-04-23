-- Migration 065: DHIEGO.AI reminders / lembretes agendados
--
-- Permite que o DHIEGO.AI agende mensagens para o Dhiego em um horário futuro
-- (ex: "me lembra amanhã às 9h de mandar o relatório"). Um cron no whatsapp-server
-- varre linhas com status='pending' e scheduled_at <= now() e dispara a mensagem
-- via baileys.sendMessage usando (session_id, chat_jid) salvos na linha.
--
-- Campos:
--   - scheduled_at: timestamptz (UTC internamente). O tool salva já convertido de
--     America/Sao_Paulo para UTC.
--   - status: pending | sent | cancelled | failed
--   - attempts / last_error: para diagnóstico se o send falhar
--   - sent_at: preenchido quando o job dispara com sucesso
--   - created_via: 'agent' (dhiego-ai), 'admin' (manual), etc.

CREATE TABLE IF NOT EXISTS dhiego_reminders (
  id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES wa_sessions(id) ON DELETE CASCADE,
  chat_jid TEXT NOT NULL,
  message TEXT NOT NULL,
  scheduled_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  sent_at TIMESTAMPTZ,
  created_via TEXT NOT NULL DEFAULT 'agent',
  source_message_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Lookup principal do scheduler: linhas pendentes cujo horário já chegou.
CREATE INDEX IF NOT EXISTS idx_dhiego_reminders_due
  ON dhiego_reminders(status, scheduled_at)
  WHERE status = 'pending';

-- Para listagens por usuário ("quais são meus lembretes?").
CREATE INDEX IF NOT EXISTS idx_dhiego_reminders_user_status
  ON dhiego_reminders(user_id, status, scheduled_at DESC);

ALTER TABLE dhiego_reminders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_all_dhiego_reminders" ON dhiego_reminders;
CREATE POLICY "service_all_dhiego_reminders" ON dhiego_reminders
  FOR ALL USING (true) WITH CHECK (true);
