-- =============================================
-- Migration 005: Allow device change on version upgrade
-- =============================================
-- When a user updates the extension to a newer version,
-- the device_id may change (new ZIP = new extension folder).
-- Instead of blocking, we allow the new device if the version is higher.
-- =============================================

-- 1. Add ext_version column to users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS ext_version TEXT;

-- 2. Helper function to compare semver versions (returns true if vA > vB)
CREATE OR REPLACE FUNCTION is_newer_semver(v_new TEXT, v_old TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  parts_new TEXT[];
  parts_old TEXT[];
  i INT;
BEGIN
  IF v_new IS NULL OR v_old IS NULL THEN RETURN FALSE; END IF;
  parts_new := string_to_array(v_new, '.');
  parts_old := string_to_array(v_old, '.');
  FOR i IN 1..GREATEST(array_length(parts_new, 1), array_length(parts_old, 1)) LOOP
    IF COALESCE(parts_new[i], '0')::INT > COALESCE(parts_old[i], '0')::INT THEN
      RETURN TRUE;
    ELSIF COALESCE(parts_new[i], '0')::INT < COALESCE(parts_old[i], '0')::INT THEN
      RETURN FALSE;
    END IF;
  END LOOP;
  RETURN FALSE; -- equal = not newer
END;
$$;

-- 3. Replace validate_token with version-aware logic
CREATE OR REPLACE FUNCTION validate_token(
  p_token TEXT,
  p_device_id TEXT DEFAULT NULL,
  p_ip_address TEXT DEFAULT NULL,
  p_location TEXT DEFAULT NULL,
  p_user_agent TEXT DEFAULT NULL,
  p_version TEXT DEFAULT NULL
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

  -- Device binding check (only when p_device_id is provided)
  IF p_device_id IS NOT NULL
     AND v_user.token_redeemed = true
     AND v_user.device_fingerprint IS NOT NULL
     AND v_user.device_fingerprint != p_device_id THEN

    -- Check if this is a version UPGRADE → allow device change
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

      -- Log as version upgrade (not blocked)
      INSERT INTO token_attempts (user_id, token_used, ip_address, location, user_agent, blocked, reason)
      VALUES (v_user.id, p_token, p_ip_address, p_location, p_user_agent, false, 'version_upgrade');

      RETURN QUERY SELECT
        v_user.id, v_user.name, v_user.email, v_user.phone, v_user.role,
        COALESCE(v_user.features, ARRAY['crm','msg','abas','pin']),
        COALESCE(v_user.allowed_phones, ARRAY[]::TEXT[]),
        'ok'::TEXT;
      RETURN;
    END IF;

    -- SAME OR OLDER VERSION: BLOCKED
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
