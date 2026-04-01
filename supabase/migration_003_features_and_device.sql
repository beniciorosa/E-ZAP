-- Migration 003: Feature permissions + Device binding + Phone validation
-- Run this in Supabase SQL Editor
-- E-ZAP v1.3.0

-- =============================================
-- 1. Feature permissions per user
-- =============================================
-- Feature keys: 'crm' (labels+hubspot+obs), 'msg', 'slice', 'abas', 'pin'
ALTER TABLE users ADD COLUMN IF NOT EXISTS features TEXT[] DEFAULT ARRAY['crm','msg','abas','pin'];

-- Admin gets ALL features including slice
UPDATE users SET features = ARRAY['crm','msg','slice','abas','pin'] WHERE role = 'admin';

-- =============================================
-- 2. Allowed WhatsApp phone numbers per user
-- =============================================
-- The extension will only work if the WhatsApp Web number matches one of these
ALTER TABLE users ADD COLUMN IF NOT EXISTS allowed_phones TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Set Dhiego's phone
UPDATE users SET allowed_phones = ARRAY['5519993473149'] WHERE LOWER(email) = 'dhiego@grupoescalada.com.br';

-- =============================================
-- 3. Token device-binding columns
-- =============================================
ALTER TABLE users ADD COLUMN IF NOT EXISTS token_redeemed BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS device_fingerprint TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS redeemed_ip TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS redeemed_location TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS redeemed_at TIMESTAMPTZ;

-- =============================================
-- 4. Token attempts tracking table
-- =============================================
CREATE TABLE IF NOT EXISTS token_attempts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  token_used TEXT NOT NULL,
  ip_address TEXT,
  location TEXT,
  user_agent TEXT,
  blocked BOOLEAN DEFAULT FALSE,
  reason TEXT DEFAULT 'login',
  attempted_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE token_attempts ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_token_attempts_user ON token_attempts(user_id);
CREATE INDEX IF NOT EXISTS idx_token_attempts_blocked ON token_attempts(blocked) WHERE blocked = true;

-- =============================================
-- 5. RPC: reset_user_device
-- =============================================
CREATE OR REPLACE FUNCTION reset_user_device(p_user_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE users SET
    token_redeemed = false,
    device_fingerprint = NULL,
    redeemed_ip = NULL,
    redeemed_location = NULL,
    redeemed_at = NULL
  WHERE id = p_user_id;
END;
$$;

-- =============================================
-- 6. RPC: update_user_features
-- =============================================
CREATE OR REPLACE FUNCTION update_user_features(p_user_id UUID, p_features TEXT[])
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE users SET features = p_features WHERE id = p_user_id;
END;
$$;

-- =============================================
-- 7. RPC: update_user_phones
-- =============================================
CREATE OR REPLACE FUNCTION update_user_phones(p_user_id UUID, p_phones TEXT[])
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE users SET allowed_phones = p_phones WHERE id = p_user_id;
END;
$$;

-- =============================================
-- 8. RPC: log_phone_mismatch (called by extension when phone doesn't match)
-- =============================================
CREATE OR REPLACE FUNCTION log_phone_mismatch(p_user_id UUID, p_detected_phone TEXT, p_ip TEXT, p_location TEXT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO token_attempts (user_id, token_used, ip_address, location, blocked, reason)
  VALUES (p_user_id, p_detected_phone, p_ip, p_location, true, 'phone_mismatch');
END;
$$;

-- =============================================
-- 9. Replace validate_token with enhanced version
-- =============================================
CREATE OR REPLACE FUNCTION validate_token(
  p_token TEXT,
  p_device_id TEXT DEFAULT NULL,
  p_ip_address TEXT DEFAULT NULL,
  p_location TEXT DEFAULT NULL,
  p_user_agent TEXT DEFAULT NULL
)
RETURNS TABLE(
  user_id UUID,
  user_name TEXT,
  user_email TEXT,
  user_phone TEXT,
  user_role TEXT,
  user_features TEXT[],
  user_allowed_phones TEXT[],
  token_status TEXT
)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_user RECORD;
BEGIN
  -- Find active user by token (case-insensitive)
  SELECT * INTO v_user FROM users
  WHERE LOWER(token) = LOWER(p_token) AND active = true
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN; -- empty result = invalid/inactive token
  END IF;

  -- Device binding check (only when p_device_id is provided, i.e. from extension)
  IF p_device_id IS NOT NULL
     AND v_user.token_redeemed = true
     AND v_user.device_fingerprint IS NOT NULL
     AND v_user.device_fingerprint != p_device_id THEN

    -- BLOCKED: another device trying to use this token
    INSERT INTO token_attempts (user_id, token_used, ip_address, location, user_agent, blocked, reason)
    VALUES (v_user.id, p_token, p_ip_address, p_location, p_user_agent, true, 'device_mismatch');

    RETURN QUERY SELECT
      v_user.id, v_user.name, v_user.email, v_user.phone, v_user.role,
      COALESCE(v_user.features, ARRAY['crm','msg','abas','pin']),
      COALESCE(v_user.allowed_phones, ARRAY[]::TEXT[]),
      'blocked_device'::TEXT;
    RETURN;
  END IF;

  -- First-time redemption: bind token to this device
  IF p_device_id IS NOT NULL AND (v_user.token_redeemed IS NOT TRUE) THEN
    UPDATE users SET
      token_redeemed = true,
      device_fingerprint = p_device_id,
      redeemed_ip = p_ip_address,
      redeemed_location = p_location,
      redeemed_at = NOW(),
      last_active = NOW()
    WHERE id = v_user.id;
  ELSE
    UPDATE users SET last_active = NOW() WHERE id = v_user.id;
  END IF;

  -- Log access (only for extension logins)
  IF p_device_id IS NOT NULL THEN
    INSERT INTO token_attempts (user_id, token_used, ip_address, location, user_agent, blocked, reason)
    VALUES (v_user.id, p_token, p_ip_address, p_location, p_user_agent, false, 'login');
  END IF;

  RETURN QUERY SELECT
    v_user.id, v_user.name, v_user.email, v_user.phone, v_user.role,
    COALESCE(v_user.features, ARRAY['crm','msg','abas','pin']),
    COALESCE(v_user.allowed_phones, ARRAY[]::TEXT[]),
    'ok'::TEXT;
END;
$$;
