-- Migration 054: Add criteria column to admin_abas
-- Permite admin adicionar vínculos automáticos (cust_id HubSpot, JID, link WhatsApp)
-- Cada string no array é um critério. Formatos aceitos:
--   - JID direto: "5511989473088@c.us" ou "12345-67890@g.us"
--   - Telefone: "+55 11 98947-3088", "5511989473088", etc.
--   - Link wa.me: "https://wa.me/5511989473088"
--   - Link grupo: "https://chat.whatsapp.com/INVITE_CODE"
--   - HubSpot cust_id: ID puro ou UUID

ALTER TABLE admin_abas ADD COLUMN IF NOT EXISTS criteria TEXT[] DEFAULT NULL;
