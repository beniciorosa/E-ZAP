-- Track group membership history
-- Records who is/was in each group, with first_seen/last_seen/left_at

CREATE TABLE IF NOT EXISTS group_members (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  group_jid TEXT NOT NULL,
  group_name TEXT,
  member_phone TEXT NOT NULL,
  member_name TEXT,
  role TEXT DEFAULT 'member',
  first_seen TIMESTAMPTZ DEFAULT now(),
  last_seen TIMESTAMPTZ DEFAULT now(),
  left_at TIMESTAMPTZ,
  recorded_by UUID REFERENCES users(id),
  UNIQUE(group_jid, member_phone)
);

CREATE INDEX IF NOT EXISTS idx_group_members_group ON group_members (group_jid);
CREATE INDEX IF NOT EXISTS idx_group_members_phone ON group_members (member_phone);

ALTER TABLE group_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY "group_members_all" ON group_members FOR ALL USING (true) WITH CHECK (true);
