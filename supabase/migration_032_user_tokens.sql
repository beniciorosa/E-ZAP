-- =====================================================
-- Migration 032: Multi-token support (user_tokens table)
-- Allows a single user to have multiple tokens, each
-- bound to its own device. Migrates existing tokens.
-- =====================================================

-- 1. Create user_tokens table
CREATE TABLE IF NOT EXISTS user_tokens (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT UNIQUE NOT NULL,
  label TEXT DEFAULT 'Principal',
  active BOOLEAN DEFAULT true,
  device_fingerprint TEXT,
  token_redeemed BOOLEAN DEFAULT false,
  redeemed_ip TEXT,
  redeemed_location TEXT,
  redeemed_at TIMESTAMPTZ,
  ext_version TEXT,
  last_active TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_tokens_user ON user_tokens(user_id);
ALTER TABLE user_tokens ENABLE ROW LEVEL SECURITY;

-- 2. Migrate existing tokens from users table
INSERT INTO user_tokens (user_id, token, label, active, device_fingerprint, token_redeemed, redeemed_ip, redeemed_location, redeemed_at, ext_version, last_active)
SELECT id, token, 'Principal', active, device_fingerprint, COALESCE(token_redeemed, false), redeemed_ip, redeemed_location, redeemed_at, ext_version, last_active
FROM users
WHERE token IS NOT NULL
ON CONFLICT (token) DO NOTHING;

-- 3. Function to generate extra tokens
CREATE OR REPLACE FUNCTION generate_extra_token(p_user_id UUID, p_label TEXT DEFAULT 'Extra')
RETURNS TEXT AS $$
DECLARE
  new_token TEXT;
  token_exists BOOLEAN;
BEGIN
  LOOP
    new_token := 'WCRM-' ||
      upper(substr(md5(random()::text), 1, 4)) || '-' ||
      upper(substr(md5(random()::text), 1, 4)) || '-' ||
      upper(substr(md5(random()::text), 1, 4));
    SELECT EXISTS(SELECT 1 FROM user_tokens WHERE token = new_token) INTO token_exists;
    EXIT WHEN NOT token_exists;
  END LOOP;

  INSERT INTO user_tokens (user_id, token, label) VALUES (p_user_id, new_token, p_label);
  RETURN new_token;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 4. Rewrite validate_token to use user_tokens table
CREATE OR REPLACE FUNCTION validate_token(
  p_token TEXT,
  p_device_id TEXT DEFAULT NULL,
  p_ip_address TEXT DEFAULT NULL,
  p_location TEXT DEFAULT NULL,
  p_user_agent TEXT DEFAULT NULL,
  p_version TEXT DEFAULT NULL,
  p_skip_log BOOLEAN DEFAULT false
)
RETURNS TABLE(
  user_id UUID,
  user_name TEXT,
  user_email TEXT,
  user_phone TEXT,
  user_role TEXT,
  user_features TEXT[],
  user_allowed_phones TEXT[],
  token_status TEXT,
  user_signature_enabled BOOLEAN
)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_tok RECORD;
  v_user RECORD;
BEGIN
  -- Find active token in user_tokens
  SELECT * INTO v_tok FROM user_tokens
  WHERE LOWER(user_tokens.token) = LOWER(p_token) AND user_tokens.active = true
  LIMIT 1;

  IF NOT FOUND THEN
    -- Fallback: check users table directly (backward compat during migration)
    SELECT * INTO v_user FROM users
    WHERE LOWER(users.token) = LOWER(p_token) AND users.active = true
    LIMIT 1;
    IF NOT FOUND THEN
      RETURN; -- empty = invalid
    END IF;
    -- Use legacy path (same as before)
    -- Device binding on users table
    IF p_device_id IS NOT NULL
       AND v_user.token_redeemed = true
       AND v_user.device_fingerprint IS NOT NULL
       AND v_user.device_fingerprint != p_device_id THEN
      IF p_version IS NOT NULL
         AND is_newer_semver(p_version, COALESCE(v_user.ext_version, '0.0.0')) THEN
        UPDATE users SET device_fingerprint = p_device_id, ext_version = p_version,
          redeemed_ip = COALESCE(p_ip_address, redeemed_ip), redeemed_location = COALESCE(p_location, redeemed_location),
          redeemed_at = NOW(), last_active = NOW() WHERE id = v_user.id;
        INSERT INTO token_attempts (user_id, token_used, ip_address, location, user_agent, blocked, reason)
        VALUES (v_user.id, p_token, p_ip_address, p_location, p_user_agent, false, 'version_upgrade');
        RETURN QUERY SELECT v_user.id, v_user.name, v_user.email, v_user.phone, v_user.role,
          COALESCE(v_user.features, ARRAY['crm','msg','abas','pin']), COALESCE(v_user.allowed_phones, ARRAY[]::TEXT[]),
          'ok'::TEXT, COALESCE(v_user.signature_enabled, false);
        RETURN;
      END IF;
      INSERT INTO token_attempts (user_id, token_used, ip_address, location, user_agent, blocked, reason)
      VALUES (v_user.id, p_token, p_ip_address, p_location, p_user_agent, true, 'device_mismatch');
      RETURN QUERY SELECT v_user.id, v_user.name, v_user.email, v_user.phone, v_user.role,
        COALESCE(v_user.features, ARRAY['crm','msg','abas','pin']), COALESCE(v_user.allowed_phones, ARRAY[]::TEXT[]),
        'blocked_device'::TEXT, COALESCE(v_user.signature_enabled, false);
      RETURN;
    END IF;
    IF p_device_id IS NOT NULL AND (v_user.token_redeemed IS NOT TRUE) THEN
      UPDATE users SET token_redeemed = true, device_fingerprint = p_device_id, ext_version = p_version,
        redeemed_ip = p_ip_address, redeemed_location = p_location, redeemed_at = NOW(), last_active = NOW()
      WHERE id = v_user.id;
    ELSE
      UPDATE users SET last_active = NOW(), ext_version = COALESCE(p_version, ext_version) WHERE id = v_user.id;
    END IF;
    IF p_device_id IS NOT NULL AND p_skip_log IS NOT TRUE THEN
      INSERT INTO token_attempts (user_id, token_used, ip_address, location, user_agent, blocked, reason)
      VALUES (v_user.id, p_token, p_ip_address, p_location, p_user_agent, false, 'login');
    END IF;
    RETURN QUERY SELECT v_user.id, v_user.name, v_user.email, v_user.phone, v_user.role,
      COALESCE(v_user.features, ARRAY['crm','msg','abas','pin']), COALESCE(v_user.allowed_phones, ARRAY[]::TEXT[]),
      'ok'::TEXT, COALESCE(v_user.signature_enabled, false);
    RETURN;
  END IF;

  -- ===== NEW PATH: token found in user_tokens =====
  -- Get user data
  SELECT * INTO v_user FROM users WHERE id = v_tok.user_id AND active = true;
  IF NOT FOUND THEN
    RETURN; -- user inactive
  END IF;

  -- Device binding check on the TOKEN (not user)
  IF p_device_id IS NOT NULL
     AND v_tok.token_redeemed = true
     AND v_tok.device_fingerprint IS NOT NULL
     AND v_tok.device_fingerprint != p_device_id THEN

    -- Version upgrade bypass
    IF p_version IS NOT NULL
       AND is_newer_semver(p_version, COALESCE(v_tok.ext_version, '0.0.0')) THEN
      UPDATE user_tokens SET
        device_fingerprint = p_device_id,
        ext_version = p_version,
        redeemed_ip = COALESCE(p_ip_address, redeemed_ip),
        redeemed_location = COALESCE(p_location, redeemed_location),
        redeemed_at = NOW(),
        last_active = NOW()
      WHERE id = v_tok.id;
      UPDATE users SET last_active = NOW() WHERE id = v_user.id;
      INSERT INTO token_attempts (user_id, token_used, ip_address, location, user_agent, blocked, reason)
      VALUES (v_user.id, p_token, p_ip_address, p_location, p_user_agent, false, 'version_upgrade');
      RETURN QUERY SELECT v_user.id, v_user.name, v_user.email, v_user.phone, v_user.role,
        COALESCE(v_user.features, ARRAY['crm','msg','abas','pin']), COALESCE(v_user.allowed_phones, ARRAY[]::TEXT[]),
        'ok'::TEXT, COALESCE(v_user.signature_enabled, false);
      RETURN;
    END IF;

    -- Blocked
    INSERT INTO token_attempts (user_id, token_used, ip_address, location, user_agent, blocked, reason)
    VALUES (v_user.id, p_token, p_ip_address, p_location, p_user_agent, true, 'device_mismatch');
    RETURN QUERY SELECT v_user.id, v_user.name, v_user.email, v_user.phone, v_user.role,
      COALESCE(v_user.features, ARRAY['crm','msg','abas','pin']), COALESCE(v_user.allowed_phones, ARRAY[]::TEXT[]),
      'blocked_device'::TEXT, COALESCE(v_user.signature_enabled, false);
    RETURN;
  END IF;

  -- First-time redemption on this token
  IF p_device_id IS NOT NULL AND (v_tok.token_redeemed IS NOT TRUE) THEN
    UPDATE user_tokens SET
      token_redeemed = true,
      device_fingerprint = p_device_id,
      ext_version = p_version,
      redeemed_ip = p_ip_address,
      redeemed_location = p_location,
      redeemed_at = NOW(),
      last_active = NOW()
    WHERE id = v_tok.id;
  ELSE
    UPDATE user_tokens SET
      last_active = NOW(),
      ext_version = COALESCE(p_version, ext_version)
    WHERE id = v_tok.id;
  END IF;

  -- Update user last_active
  UPDATE users SET last_active = NOW() WHERE id = v_user.id;

  -- Log
  IF p_device_id IS NOT NULL AND p_skip_log IS NOT TRUE THEN
    INSERT INTO token_attempts (user_id, token_used, ip_address, location, user_agent, blocked, reason)
    VALUES (v_user.id, p_token, p_ip_address, p_location, p_user_agent, false, 'login');
  END IF;

  RETURN QUERY SELECT v_user.id, v_user.name, v_user.email, v_user.phone, v_user.role,
    COALESCE(v_user.features, ARRAY['crm','msg','abas','pin']),
    COALESCE(v_user.allowed_phones, ARRAY[]::TEXT[]),
    'ok'::TEXT,
    COALESCE(v_user.signature_enabled, false);
END;
$$;
