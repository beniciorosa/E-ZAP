-- ===== wa_contacts: add linked_jid for LID -> real JID resolution =====
-- Production already exposes this column and the WhatsApp server patches it
-- from chats.phoneNumberShare. Versioning it here makes the schema explicit
-- and lets DHIEGO.AI / sendMessage resolve @lid chats through the real JID.

ALTER TABLE wa_contacts
  ADD COLUMN IF NOT EXISTS linked_jid TEXT;

CREATE INDEX IF NOT EXISTS idx_wa_contacts_linked_jid
  ON wa_contacts(session_id, linked_jid)
  WHERE linked_jid IS NOT NULL;
