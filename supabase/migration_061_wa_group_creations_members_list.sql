-- Migration 061: Adicionar members_list (JSONB) em wa_group_creations
-- Registra quem foi incluído no grupo (direto ou via convite DM) por row.
-- Shape: [
--   { role, phone, name, in_group: bool, dm_sent: bool|null }
-- ]
-- Roles: "client" | "mentor" | "cx2" | "escalada" | "helper"
-- in_group: true se entrou via groupCreate, false se só recebeu DM com invite link
-- dm_sent: true/false se tentou mandar DM; null se não aplicável (entrou direto)

ALTER TABLE wa_group_creations
  ADD COLUMN IF NOT EXISTS members_list JSONB;

COMMENT ON COLUMN wa_group_creations.members_list IS
  'Lista de membros esperados no grupo: [{role, phone, name, in_group, dm_sent}]. Role em {client, mentor, cx2, escalada, helper}.';
