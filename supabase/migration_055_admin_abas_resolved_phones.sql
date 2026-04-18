-- Migration 055: Add resolved_phones to admin_abas
-- Quando admin coloca um critério hubspot:ID, o admin panel busca o telefone
-- via HubSpot API e armazena aqui para o matcher da extensão usar diretamente,
-- sem depender da tabela mentorados (que só tem alguns tickets).

ALTER TABLE admin_abas ADD COLUMN IF NOT EXISTS resolved_phones TEXT[] DEFAULT NULL;
