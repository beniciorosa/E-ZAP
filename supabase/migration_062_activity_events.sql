-- Migration 062: tabela unificada de eventos de produção (activity log).
-- Cada ação do ecossistema E-ZAP (criação de grupo, DM, quarentena, rate-limit,
-- resolve-tickets, validação onWhatsApp, etc) vira 1 row aqui.
-- Usada pela sidebar de log em tempo real em grupos.html + insights do dia
-- anterior + auditoria + aprendizado empírico das hipóteses em _insights.md.
--
-- Retenção recomendada: 30 dias (cleanup via cron/RPC separada).

CREATE TABLE IF NOT EXISTS activity_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  -- Coluna generated — permite filtrar por "dia" em America/Sao_Paulo facilmente.
  -- Virada do dia acontece meia-noite BRT, não UTC — crucial pra "insights de ontem".
  day date GENERATED ALWAYS AS ((occurred_at AT TIME ZONE 'America/Sao_Paulo')::date) STORED,

  event_type text NOT NULL,
  -- Convenções de nome: <domain>:<action>
  -- Exemplos:
  --   group_create_job:started | :completed | :cancelled | :rate_limited | :error
  --   group_create:start | :success | :failed | :rate_limit | :bad_request_fallback
  --   dm_sent:client | :cx2 | :escalada
  --   dm_failed:client | :cx2 | :escalada
  --   session:quarantine_enter | :quarantine_release
  --   resolve_tickets | phone_validation:adjusted_9_br | :not_on_whatsapp
  --   template:saved | :deleted | :default_changed

  level text NOT NULL DEFAULT 'info',  -- debug | info | warn | error | critical

  -- Sessão envolvida (se houver). Snapshot do label/phone ficam preservados mesmo
  -- que a sessão seja deletada depois (FK com ON DELETE SET NULL).
  session_id uuid REFERENCES wa_sessions(id) ON DELETE SET NULL,
  session_label text,
  session_phone text,

  -- Job context (se evento atrelado a job de create-groups/extract/add).
  job_id text,

  -- Grupo context (se evento atrelado a grupo criado).
  group_jid text,
  group_name text,

  message text NOT NULL,

  -- Dados específicos do evento. Estrutura varia por event_type:
  --   group_create:*     → {specHash, memberCount, deltaMs, ...}
  --   dm_sent:*          → {targetPhone, adjusted9br, ...}
  --   phone_validation:* → {originalPhone, canonicalJid, adjusted, ...}
  --   resolve_tickets    → {ticketCount, okCount, adjustedCount, invalidCount, validatorPhone}
  metadata jsonb
);

CREATE INDEX IF NOT EXISTS idx_activity_events_day
  ON activity_events(day DESC, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_activity_events_session
  ON activity_events(session_id, occurred_at DESC)
  WHERE session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_activity_events_type
  ON activity_events(event_type, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_activity_events_job
  ON activity_events(job_id, occurred_at DESC)
  WHERE job_id IS NOT NULL;

COMMENT ON TABLE activity_events IS 'Log unificado de eventos de produção do E-ZAP. Alimentado por services/activity-log.js via logEvent(). Consumido pela sidebar de log em grupos.html via socket.io (activity:event) e endpoint GET /api/activity.';

-- RPC pra cleanup agendado (chamada por cron no whatsapp-server).
-- Mantém últimos N dias (default 30). Deleta em batches pra não travar o DB.
CREATE OR REPLACE FUNCTION cleanup_old_activity_events(keep_days int DEFAULT 30)
RETURNS int LANGUAGE plpgsql AS $$
DECLARE
  deleted_count int := 0;
  batch_deleted int;
BEGIN
  LOOP
    DELETE FROM activity_events
    WHERE id IN (
      SELECT id FROM activity_events
      WHERE day < (now() AT TIME ZONE 'America/Sao_Paulo')::date - keep_days
      LIMIT 1000
    );
    GET DIAGNOSTICS batch_deleted = ROW_COUNT;
    deleted_count := deleted_count + batch_deleted;
    EXIT WHEN batch_deleted = 0;
  END LOOP;
  RETURN deleted_count;
END;
$$;

COMMENT ON FUNCTION cleanup_old_activity_events IS 'Apaga activity_events mais antigos que keep_days (default 30). Roda em batches de 1000 pra não travar. Retorna total deletado.';
