-- Migration 009: add contact_jid columns to aba_contacts and pinned_contacts
--
-- Por que:
--   Ate agora identificavamos contatos salvos (em abas / pins) apenas pelo
--   nome exibido no WhatsApp (ex: "Augusto Stoeterau | Thiago Rocha"). Isso
--   quebrava filtros quando o row nao estava renderizado no virtual scroll
--   ou quando o nome salvo diferia do nome do DOM.
--
-- O que muda:
--   Passamos a armazenar tambem o JID (Jabber ID) do chat do WA Web
--   (ex: "5511999999999@c.us" ou "xxxx@g.us"). O JID e estavel e unico
--   mesmo se o usuario renomear o contato.
--
-- Retrocompatibilidade:
--   contact_jid e nullable. Pins/abas antigos continuam funcionando com
--   match tolerante por nome. Clientes novos resolvem o JID via
--   store-bridge.js e populam o campo progressivamente.

ALTER TABLE aba_contacts
  ADD COLUMN IF NOT EXISTS contact_jid text;

ALTER TABLE pinned_contacts
  ADD COLUMN IF NOT EXISTS contact_jid text;

-- Index para lookups por JID (filtros podem consultar varios ao mesmo tempo)
CREATE INDEX IF NOT EXISTS idx_aba_contacts_jid ON aba_contacts(contact_jid);
CREATE INDEX IF NOT EXISTS idx_pinned_contacts_jid ON pinned_contacts(contact_jid);
