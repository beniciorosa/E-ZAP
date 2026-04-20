-- Migration 058: Add resolved_phone_jids to admin_abas
-- Mapa {phone: [jids]} pra deduplicar contagem por PESSOA, não por chat.
-- Ex: Mateus tem DM (5511...@s.whatsapp.net) + grupo (120363...@g.us)
-- = 2 chats mas 1 pessoa. Sem esse mapa, contador soma 2.

ALTER TABLE admin_abas ADD COLUMN IF NOT EXISTS resolved_phone_jids JSONB DEFAULT NULL;
