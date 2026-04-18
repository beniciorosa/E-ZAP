-- ==============================================================
-- Migration 054: Tabela hubspot_tickets (espelho dos tickets HubSpot)
-- ==============================================================
-- Cada ticket do HubSpot (de qualquer pipeline) vira 1 row.
-- Linkagem pre_mentoria <-> mentoria via pre_mentoria_ticket_id.
-- VIEW v_ticket_full mescla os 2 tickets via COALESCE.
-- Trigger sync_hubspot_tickets_to_mentorados espelha tier em mentorados.
-- ==============================================================

-- 1. TABELA PRINCIPAL
CREATE TABLE IF NOT EXISTS hubspot_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Core
  ticket_id bigint NOT NULL UNIQUE,
  ticket_name text,
  owner_id text,
  owner_name text,
  owner_email text,
  pipeline_id text,
  pipeline_name text,
  pipeline_stage_id text,
  pipeline_stage_name text,
  pipeline_type text,         -- "mentoria" | "pre_mentoria" | "aprovacao_financeiro" | "outro"
  mentor_responsavel_id text,
  mentor_responsavel_name text,
  tier text,                  -- "starter" | "pro" | "business" | null
  mentoria_starter boolean,
  mentoria_pro boolean,
  mentoria_business boolean,
  status_ticket text,         -- "open" | "closed"
  priority text,
  ticket_created_at timestamptz,
  ticket_updated_at timestamptz,
  ticket_closed_at timestamptz,

  -- Linkagem entre tickets
  pre_mentoria_ticket_id bigint,
  mentoria_ticket_id bigint,

  -- Mentorado
  nome_do_mentorado text,
  whatsapp_do_mentorado text,
  email_do_mentorado text,
  nicho_produtos text,
  cidade_estado text,
  situacao_atual text,
  faturamento_range text,
  modelo_de_mentoria text,
  upgrade_de_mentoria text,
  seller_id_meli text,
  seller_nickname_meli text,
  seller_email_meli text,

  -- Contrato (só dígitos em cep e cpf_cnpj)
  cep text,                                  -- 8 dígitos
  endereco_completo text,
  razao_social_ou_nome text,
  cpf_cnpj text,                             -- 11 ou 14 dígitos
  tipo_contratante text,                     -- "cpf" | "cnpj"
  email_contrato text,
  telefone_contrato text,                    -- E.164 sem +
  link_contrato text,
  data_assinatura_contrato timestamptz,
  contrato_obtido boolean,

  -- Operacional
  data_inicio_blocos timestamptz,
  data_termino_1o_bloco timestamptz,
  data_call_dhiego timestamptz,
  calls_restantes int,
  calls_totais int,
  quantidade_calls_1o_bloco int,
  num_notes int,
  primary_contact_id text,

  -- Audit
  grupo_whatsapp_link text,
  hs_tag_ids text[],
  mentorado_estagnado boolean,
  mentoria_finalizada boolean,
  renovacao_nota_satisfacao numeric,

  -- Meta
  raw_payload jsonb,
  synced_from text,                          -- "webhook" | "backfill" | "manual"
  synced_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- 2. ÍNDICES
CREATE INDEX IF NOT EXISTS idx_hubspot_tickets_owner_id
  ON hubspot_tickets(owner_id) WHERE owner_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_hubspot_tickets_pipeline_type
  ON hubspot_tickets(pipeline_type);
CREATE INDEX IF NOT EXISTS idx_hubspot_tickets_pipeline_stage_id
  ON hubspot_tickets(pipeline_stage_id);
CREATE INDEX IF NOT EXISTS idx_hubspot_tickets_primary_contact_id
  ON hubspot_tickets(primary_contact_id) WHERE primary_contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_hubspot_tickets_pre_mentoria_ticket_id
  ON hubspot_tickets(pre_mentoria_ticket_id) WHERE pre_mentoria_ticket_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_hubspot_tickets_seller_id_meli
  ON hubspot_tickets(seller_id_meli) WHERE seller_id_meli IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_hubspot_tickets_status
  ON hubspot_tickets(status_ticket);

-- 3. VIEW v_ticket_full (merge automatico pre <-> mentoria)
CREATE OR REPLACE VIEW v_ticket_full AS
SELECT
  t.*,
  -- Contrato: prioriza proprio ticket, fallback pré-mentoria
  COALESCE(t.cep, pre.cep) AS cep_final,
  COALESCE(t.endereco_completo, pre.endereco_completo) AS endereco_completo_final,
  COALESCE(t.razao_social_ou_nome, pre.razao_social_ou_nome) AS razao_social_final,
  COALESCE(t.cpf_cnpj, pre.cpf_cnpj) AS cpf_cnpj_final,
  COALESCE(t.tipo_contratante, pre.tipo_contratante) AS tipo_contratante_final,
  COALESCE(t.email_contrato, pre.email_contrato) AS email_contrato_final,
  COALESCE(t.telefone_contrato, pre.telefone_contrato) AS telefone_contrato_final,
  COALESCE(t.link_contrato, pre.link_contrato) AS link_contrato_final,
  COALESCE(t.data_assinatura_contrato, pre.data_assinatura_contrato) AS data_assinatura_contrato_final,
  COALESCE(t.contrato_obtido, pre.contrato_obtido) AS contrato_obtido_final,
  pre.ticket_id AS pre_mentoria_resolved_id,
  -- Grupos WhatsApp criados pra este ticket
  (SELECT json_agg(g.*) FROM wa_group_creations g WHERE g.hubspot_ticket_id = t.ticket_id) AS groups
FROM hubspot_tickets t
LEFT JOIN hubspot_tickets pre
  ON pre.ticket_id = t.pre_mentoria_ticket_id;

-- 4. TRIGGER: sync hubspot_tickets -> mentorados (preserva fluxo existente)
CREATE OR REPLACE FUNCTION sync_hubspot_tickets_to_mentorados()
RETURNS TRIGGER AS $$
BEGIN
  -- Só propaga pra mentorados se tier foi setado (= virou mentorado de fato)
  IF NEW.tier IS NULL AND NEW.mentoria_starter IS NOT TRUE AND NEW.mentoria_pro IS NOT TRUE AND NEW.mentoria_business IS NOT TRUE THEN
    RETURN NEW;
  END IF;

  -- Upsert em mentorados mantendo o schema existente
  INSERT INTO mentorados (
    ticket_id,
    ticket_name,
    mentor_responsavel,
    whatsapp_do_mentorado,
    mentoria_starter,
    mentoria_pro,
    mentoria_business,
    pipeline_id,
    pipeline_stage_id,
    pipeline_name,
    pipeline_stage_name,
    raw_payload,
    updated_at
  ) VALUES (
    NEW.ticket_id,
    NEW.ticket_name,
    NEW.mentor_responsavel_name,
    NEW.whatsapp_do_mentorado,
    COALESCE(NEW.mentoria_starter, false),
    COALESCE(NEW.mentoria_pro, false),
    COALESCE(NEW.mentoria_business, false),
    NEW.pipeline_id,
    NEW.pipeline_stage_id,
    NEW.pipeline_name,
    NEW.pipeline_stage_name,
    NEW.raw_payload,
    NOW()
  )
  ON CONFLICT (ticket_id) DO UPDATE SET
    ticket_name = EXCLUDED.ticket_name,
    mentor_responsavel = EXCLUDED.mentor_responsavel,
    whatsapp_do_mentorado = EXCLUDED.whatsapp_do_mentorado,
    mentoria_starter = EXCLUDED.mentoria_starter,
    mentoria_pro = EXCLUDED.mentoria_pro,
    mentoria_business = EXCLUDED.mentoria_business,
    pipeline_id = EXCLUDED.pipeline_id,
    pipeline_stage_id = EXCLUDED.pipeline_stage_id,
    pipeline_name = EXCLUDED.pipeline_name,
    pipeline_stage_name = EXCLUDED.pipeline_stage_name,
    raw_payload = EXCLUDED.raw_payload,
    updated_at = NOW();

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_hubspot_tickets_to_mentorados ON hubspot_tickets;
CREATE TRIGGER trg_sync_hubspot_tickets_to_mentorados
  AFTER INSERT OR UPDATE ON hubspot_tickets
  FOR EACH ROW
  EXECUTE FUNCTION sync_hubspot_tickets_to_mentorados();
