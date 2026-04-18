-- ==============================================================
-- Migration 053: Enriquece wa_group_creations com dados HubSpot
-- ==============================================================
-- Adiciona colunas hubspot_* + client_phone + mentor_session_*
-- Faz backfill best-effort por match de group_name <-> mentorados.ticket_name
-- Cria trigger que sincroniza mudanças de mentorados -> wa_group_creations
-- ==============================================================

-- 1. Colunas novas em wa_group_creations
ALTER TABLE wa_group_creations
  ADD COLUMN IF NOT EXISTS hubspot_ticket_id bigint,
  ADD COLUMN IF NOT EXISTS hubspot_ticket_name text,
  ADD COLUMN IF NOT EXISTS hubspot_mentor text,
  ADD COLUMN IF NOT EXISTS hubspot_tier text,
  ADD COLUMN IF NOT EXISTS hubspot_pipeline_id text,
  ADD COLUMN IF NOT EXISTS hubspot_pipeline_stage_id text,
  ADD COLUMN IF NOT EXISTS hubspot_pipeline_name text,
  ADD COLUMN IF NOT EXISTS hubspot_pipeline_stage_name text,
  ADD COLUMN IF NOT EXISTS hubspot_last_synced_at timestamptz,
  ADD COLUMN IF NOT EXISTS client_phone text,
  ADD COLUMN IF NOT EXISTS mentor_session_id uuid,
  ADD COLUMN IF NOT EXISTS mentor_session_phone text;

CREATE INDEX IF NOT EXISTS idx_wa_group_creations_hubspot_ticket_id
  ON wa_group_creations(hubspot_ticket_id) WHERE hubspot_ticket_id IS NOT NULL;

-- 2. Pipeline fields em mentorados (fonte do webhook HubSpot)
ALTER TABLE mentorados
  ADD COLUMN IF NOT EXISTS pipeline_id text,
  ADD COLUMN IF NOT EXISTS pipeline_stage_id text,
  ADD COLUMN IF NOT EXISTS pipeline_name text,
  ADD COLUMN IF NOT EXISTS pipeline_stage_name text;

-- 3. Backfill best-effort (só rows com match único em mentorados.ticket_name)
WITH matched AS (
  SELECT
    g.id AS creation_id,
    m.ticket_id,
    m.ticket_name,
    m.mentor_responsavel,
    m.whatsapp_do_mentorado,
    CASE
      WHEN m.mentoria_business THEN 'business'
      WHEN m.mentoria_pro THEN 'pro'
      WHEN m.mentoria_starter THEN 'starter'
      ELSE NULL
    END AS tier,
    COUNT(*) OVER (PARTITION BY g.id) AS match_count
  FROM wa_group_creations g
  JOIN mentorados m
    ON g.group_name ILIKE (m.ticket_name || ' | %')
    OR g.group_name = m.ticket_name
  WHERE g.hubspot_ticket_id IS NULL
)
UPDATE wa_group_creations g
SET
  hubspot_ticket_id = matched.ticket_id,
  hubspot_ticket_name = matched.ticket_name,
  hubspot_mentor = matched.mentor_responsavel,
  hubspot_tier = matched.tier,
  client_phone = COALESCE(g.client_phone, matched.whatsapp_do_mentorado)
FROM matched
WHERE g.id = matched.creation_id
  AND matched.match_count = 1;

-- 4. Trigger: propaga mudanças em mentorados para wa_group_creations
--    (usado pelo sync automático via webhook HubSpot)
CREATE OR REPLACE FUNCTION sync_ticket_to_group_creations()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE wa_group_creations
  SET
    hubspot_ticket_name = NEW.ticket_name,
    hubspot_mentor = NEW.mentor_responsavel,
    hubspot_tier = CASE
      WHEN NEW.mentoria_business THEN 'business'
      WHEN NEW.mentoria_pro THEN 'pro'
      WHEN NEW.mentoria_starter THEN 'starter'
      ELSE NULL
    END,
    hubspot_pipeline_id = NEW.pipeline_id,
    hubspot_pipeline_stage_id = NEW.pipeline_stage_id,
    hubspot_pipeline_name = NEW.pipeline_name,
    hubspot_pipeline_stage_name = NEW.pipeline_stage_name,
    client_phone = COALESCE(wa_group_creations.client_phone, NEW.whatsapp_do_mentorado),
    hubspot_last_synced_at = NOW()
  WHERE hubspot_ticket_id = NEW.ticket_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_mentorados_to_group_creations ON mentorados;
CREATE TRIGGER trg_sync_mentorados_to_group_creations
  AFTER INSERT OR UPDATE ON mentorados
  FOR EACH ROW
  EXECUTE FUNCTION sync_ticket_to_group_creations();
