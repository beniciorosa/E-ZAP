-- Migration 025: User signature feature
-- When enabled, messages sent by this user will be prefixed with their name
-- e.g. "*Diego Rosa:*\nMensagem aqui"

-- 1. Add signature_enabled column to users
ALTER TABLE users ADD COLUMN IF NOT EXISTS signature_enabled boolean DEFAULT false;

-- 2. Add signature_author column to message_events (for attribution)
ALTER TABLE message_events ADD COLUMN IF NOT EXISTS signature_author text DEFAULT NULL;

-- 2. Update validate_token to return signature_enabled
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
  v_user RECORD;
BEGIN
  -- Find active user by token (case-insensitive)
  SELECT * INTO v_user FROM users
  WHERE LOWER(token) = LOWER(p_token) AND active = true
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN; -- empty result = invalid/inactive token
  END IF;

  -- Device binding check (only when p_device_id is provided)
  IF p_device_id IS NOT NULL
     AND v_user.token_redeemed = true
     AND v_user.device_fingerprint IS NOT NULL
     AND v_user.device_fingerprint != p_device_id THEN

    -- Check if this is a version UPGRADE -> allow device change
    IF p_version IS NOT NULL
       AND is_newer_semver(p_version, COALESCE(v_user.ext_version, '0.0.0')) THEN

      -- VERSION UPGRADE: re-bind token to new device
      UPDATE users SET
        device_fingerprint = p_device_id,
        ext_version = p_version,
        redeemed_ip = COALESCE(p_ip_address, redeemed_ip),
        redeemed_location = COALESCE(p_location, redeemed_location),
        redeemed_at = NOW(),
        last_active = NOW()
      WHERE id = v_user.id;

      -- Always log version upgrades (security event)
      INSERT INTO token_attempts (user_id, token_used, ip_address, location, user_agent, blocked, reason)
      VALUES (v_user.id, p_token, p_ip_address, p_location, p_user_agent, false, 'version_upgrade');

      RETURN QUERY SELECT
        v_user.id, v_user.name, v_user.email, v_user.phone, v_user.role,
        COALESCE(v_user.features, ARRAY['crm','msg','abas','pin']),
        COALESCE(v_user.allowed_phones, ARRAY[]::TEXT[]),
        'ok'::TEXT,
        COALESCE(v_user.signature_enabled, false);
      RETURN;
    END IF;

    -- SAME OR OLDER VERSION: BLOCKED (always log security events)
    INSERT INTO token_attempts (user_id, token_used, ip_address, location, user_agent, blocked, reason)
    VALUES (v_user.id, p_token, p_ip_address, p_location, p_user_agent, true, 'device_mismatch');

    RETURN QUERY SELECT
      v_user.id, v_user.name, v_user.email, v_user.phone, v_user.role,
      COALESCE(v_user.features, ARRAY['crm','msg','abas','pin']),
      COALESCE(v_user.allowed_phones, ARRAY[]::TEXT[]),
      'blocked_device'::TEXT,
      COALESCE(v_user.signature_enabled, false);
    RETURN;
  END IF;

  -- First-time redemption: bind token to this device
  IF p_device_id IS NOT NULL AND (v_user.token_redeemed IS NOT TRUE) THEN
    UPDATE users SET
      token_redeemed = true,
      device_fingerprint = p_device_id,
      ext_version = p_version,
      redeemed_ip = p_ip_address,
      redeemed_location = p_location,
      redeemed_at = NOW(),
      last_active = NOW()
    WHERE id = v_user.id;
  ELSE
    -- Update version + last_active on normal login
    UPDATE users SET
      last_active = NOW(),
      ext_version = COALESCE(p_version, ext_version)
    WHERE id = v_user.id;
  END IF;

  -- Log access ONLY for real logins (skip silent revalidations)
  IF p_device_id IS NOT NULL AND p_skip_log IS NOT TRUE THEN
    INSERT INTO token_attempts (user_id, token_used, ip_address, location, user_agent, blocked, reason)
    VALUES (v_user.id, p_token, p_ip_address, p_location, p_user_agent, false, 'login');
  END IF;

  RETURN QUERY SELECT
    v_user.id, v_user.name, v_user.email, v_user.phone, v_user.role,
    COALESCE(v_user.features, ARRAY['crm','msg','abas','pin']),
    COALESCE(v_user.allowed_phones, ARRAY[]::TEXT[]),
    'ok'::TEXT,
    COALESCE(v_user.signature_enabled, false);
END;
$$;
