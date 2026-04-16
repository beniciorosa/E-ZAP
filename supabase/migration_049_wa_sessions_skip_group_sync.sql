-- migration_049: add skip_group_sync flag to wa_sessions
-- When true, the Baileys connection.open handler skips the heavy
-- syncGroupMetadata call (sock.groupFetchAllParticipating) on reconnect.
-- This saves a significant IQ batch for sessions with many groups
-- (e.g. Escalada Ltda with 719 groups, CX, CX2, Follow Up).
-- Controllable per-session via the grupos.html sessions card toggle.

ALTER TABLE wa_sessions
  ADD COLUMN IF NOT EXISTS skip_group_sync BOOLEAN NOT NULL DEFAULT false;

-- Pre-set the 4 heavy sessions
UPDATE wa_sessions SET skip_group_sync = true
  WHERE phone IN ('5519993473149', '5519971714386', '5519971505209', '5519986123134');
