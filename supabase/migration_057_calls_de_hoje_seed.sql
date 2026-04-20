-- Migration 057: Seed da aba "CALLS DE HOJE"
-- Cria a admin_aba que será populada automaticamente pelo cron diário
-- 00:01 (whatsapp-server) com os JIDs (chats individuais + grupos) dos
-- contatos que têm reunião agendada no HubSpot pra hoje.

INSERT INTO admin_abas (name, color, icon, position, active, visible_to)
VALUES ('CALLS DE HOJE', '#ef4444', '🎥', 0, true, NULL)
ON CONFLICT DO NOTHING;
