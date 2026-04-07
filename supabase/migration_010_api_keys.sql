-- Migration 010: API Keys for public REST API
-- Creates api_keys table and api_usage_logs table

-- API Keys table
CREATE TABLE IF NOT EXISTS api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_hash TEXT NOT NULL,
  key_prefix TEXT NOT NULL,         -- first 12 chars for display (ezap_live_xx)
  label TEXT DEFAULT 'Default',     -- user-friendly name
  scopes TEXT[] DEFAULT '{read}',   -- read, write, flows, messages
  rate_limit_per_min INT DEFAULT 60,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

-- Usage logs table
CREATE TABLE IF NOT EXISTS api_usage_logs (
  id BIGSERIAL PRIMARY KEY,
  api_key_id UUID REFERENCES api_keys(id) ON DELETE SET NULL,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  endpoint TEXT NOT NULL,
  method TEXT NOT NULL,
  status_code INT,
  response_ms INT,
  ip_address TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(key_prefix);
CREATE INDEX IF NOT EXISTS idx_api_usage_key ON api_usage_logs(api_key_id);
CREATE INDEX IF NOT EXISTS idx_api_usage_user ON api_usage_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_api_usage_created ON api_usage_logs(created_at);

-- RLS
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_usage_logs ENABLE ROW LEVEL SECURITY;

-- Policies: service role can do everything
CREATE POLICY "service_all_api_keys" ON api_keys FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_all_api_usage" ON api_usage_logs FOR ALL USING (true) WITH CHECK (true);

-- RPC: validate an API key and return user info
CREATE OR REPLACE FUNCTION validate_api_key(p_key_hash TEXT)
RETURNS TABLE(user_id UUID, user_name TEXT, scopes TEXT[], rate_limit INT, api_key_id UUID)
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN QUERY
  SELECT
    ak.user_id,
    u.name AS user_name,
    ak.scopes,
    ak.rate_limit_per_min AS rate_limit,
    ak.id AS api_key_id
  FROM api_keys ak
  JOIN users u ON u.id = ak.user_id
  WHERE ak.key_hash = p_key_hash
    AND ak.active = true
    AND ak.revoked_at IS NULL
    AND u.active = true;

  -- Update last_used_at
  UPDATE api_keys SET last_used_at = now() WHERE key_hash = p_key_hash;
END;
$$;
