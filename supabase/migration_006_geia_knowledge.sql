-- GEIA Knowledge Base table
CREATE TABLE IF NOT EXISTS geia_knowledge (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  title TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'text' CHECK (type IN ('text', 'link', 'pdf')),
  content TEXT,
  url TEXT,
  file_path TEXT,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Enable RLS
ALTER TABLE geia_knowledge ENABLE ROW LEVEL SECURITY;

-- Policy: service role can do everything
CREATE POLICY "Service role full access on geia_knowledge"
  ON geia_knowledge
  FOR ALL
  USING (true)
  WITH CHECK (true);
