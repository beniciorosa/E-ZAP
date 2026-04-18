-- Migration 056: Add resolved_jids to admin_abas
-- Mais robusto que resolved_phones: armazena JIDs completos (contact_jid de pessoas
-- + group_jid de grupos) para o matcher fazer comparação direta sem inferência.
--
-- Quando admin salva uma aba com critério hubspot:ID:
--   1. Resolve ID → phone (via /api/hubspot/resolve-tickets)
--   2. Busca wa_contacts WHERE phone = digits → pega TODOS os contact_jids (@s.whatsapp.net + @lid)
--   3. Busca group_members WHERE member_phone IN esses contact_jids → pega TODOS os group_jids
--   4. Salva tudo em resolved_jids
--
-- Matcher na extensão: contact_jid_atual in resolved_jids → match (lowercase comparison).

ALTER TABLE admin_abas ADD COLUMN IF NOT EXISTS resolved_jids TEXT[] DEFAULT NULL;
