-- Migration 063: vcard_sent_registry
-- Registra quais clientes (phone canônico) já tiveram "vCard" (na real, uma
-- mensagem de texto com nome + número formatado BR) enviado pro self-chat
-- de qual mentor. Previne re-envio duplicado e alimenta o flag
-- `vcardAlreadySent` no /resolve-tickets.
--
-- Nota de naming: a coluna/tabela usa "vcard" como termo interno mesmo a
-- implementação sendo texto. Motivo: WhatsApp não permite compartilhar
-- contato (vCard real) que não está na agenda do remetente. Texto formatado
-- com auto-detecção de número resolve o problema com UX aceitável (mentor
-- toca no número → "Adicionar aos contatos").
--
-- Flow: user clica "📇 VCard" em grupos.html → resolve tickets → pra cada
-- mentor, envia sendMessage(sock.user.id, {text:"..."}) (self-chat) com
-- "Nome | +55 DDD 9XXXX-XXXX" de cada cliente. 1 row aqui por cliente.

CREATE TABLE IF NOT EXISTS vcard_sent_registry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mentor_session_id uuid NOT NULL REFERENCES wa_sessions(id) ON DELETE CASCADE,
  client_phone text NOT NULL,
  client_name text,
  ticket_id bigint,
  resolved_jid text,
  sent_at timestamptz DEFAULT now(),
  status text DEFAULT 'sent',  -- sent | failed
  UNIQUE (mentor_session_id, client_phone)
);

CREATE INDEX IF NOT EXISTS idx_vcard_registry_mentor
  ON vcard_sent_registry(mentor_session_id, sent_at DESC);

COMMENT ON TABLE vcard_sent_registry IS 'Lista de contatos enviados pra self-chat de cada mentor (texto com nome + número BR formatado). Evita duplicata + integra com resolve-tickets (flag vcardAlreadySent).';
