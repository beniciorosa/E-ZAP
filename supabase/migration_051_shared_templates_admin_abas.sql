-- Migration 051: Shared templates + Admin ABAS
-- Templates de mensagem compartilhados + Abas criadas pelo admin

-- ===== 1. SHARED TEMPLATES =====
CREATE TABLE IF NOT EXISTS shared_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  category TEXT,
  messages JSONB NOT NULL DEFAULT '[]',
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shared_templates_active ON shared_templates(active);
ALTER TABLE shared_templates ENABLE ROW LEVEL SECURITY;

-- ===== 2. ADMIN ABAS =====
CREATE TABLE IF NOT EXISTS admin_abas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  color TEXT DEFAULT '#4d96ff',
  position INTEGER DEFAULT 0,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_abas_active ON admin_abas(active);
ALTER TABLE admin_abas ENABLE ROW LEVEL SECURITY;

-- ===== 3. ADMIN ABA CONTACTS =====
CREATE TABLE IF NOT EXISTS admin_aba_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  aba_id UUID REFERENCES admin_abas(id) ON DELETE CASCADE,
  contact_name TEXT NOT NULL,
  contact_jid TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(aba_id, contact_name)
);

CREATE INDEX IF NOT EXISTS idx_admin_aba_contacts_aba ON admin_aba_contacts(aba_id);
ALTER TABLE admin_aba_contacts ENABLE ROW LEVEL SECURITY;
