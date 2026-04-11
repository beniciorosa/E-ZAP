-- migration_035_mentorados.sql
-- Tabela para tickets/mentorados recebidos via webhook externo (Hubspot)

CREATE TABLE IF NOT EXISTS mentorados (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id BIGINT UNIQUE NOT NULL,
  ticket_name TEXT NOT NULL,
  mentor_responsavel TEXT,
  whatsapp_do_mentorado TEXT,
  mentoria_starter BOOLEAN NOT NULL DEFAULT FALSE,
  mentoria_pro BOOLEAN NOT NULL DEFAULT FALSE,
  mentoria_business BOOLEAN NOT NULL DEFAULT FALSE,
  raw_payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mentorados_ticket_id ON mentorados(ticket_id);
CREATE INDEX IF NOT EXISTS idx_mentorados_whatsapp ON mentorados(whatsapp_do_mentorado);
CREATE INDEX IF NOT EXISTS idx_mentorados_mentor ON mentorados(mentor_responsavel);
CREATE INDEX IF NOT EXISTS idx_mentorados_created_at ON mentorados(created_at DESC);

ALTER TABLE mentorados ENABLE ROW LEVEL SECURITY;

-- Segue padrao do projeto: service role tem acesso total, regras de app ficam no backend
DROP POLICY IF EXISTS "service_full_access_mentorados" ON mentorados;
CREATE POLICY "service_full_access_mentorados"
  ON mentorados
  FOR ALL
  USING (true)
  WITH CHECK (true);
