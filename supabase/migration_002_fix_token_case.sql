-- Fix: Make token validation case-insensitive
-- Also update admin user name and email

CREATE OR REPLACE FUNCTION validate_token(p_token TEXT)
RETURNS TABLE(
  user_id UUID,
  user_name TEXT,
  user_email TEXT,
  user_phone TEXT,
  user_role TEXT
) AS $$
BEGIN
  -- Update last_active (case-insensitive match)
  UPDATE users SET last_active = now() WHERE LOWER(token) = LOWER(p_token) AND active = true;

  RETURN QUERY
  SELECT id, name, email, phone, role
  FROM users
  WHERE LOWER(token) = LOWER(p_token) AND active = true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Update admin user with correct name and email
UPDATE users
SET name = 'Dhiego Rosa',
    email = 'dhiego@grupoescalada.com.br'
WHERE role = 'admin' AND email = 'admin@wcrm.com';
