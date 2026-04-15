-- ===== Functional indexes for validate_token() =====
-- validate_token() filters by LOWER(token) = LOWER(p_token), which can NOT
-- use a plain btree index on token. Without a functional index, every login
-- did a seq scan on user_tokens AND users. With the PostgREST connection
-- pool saturated by the whatsapp-server reconnect storm, admin.html login
-- requests queued for 60-120s waiting for a pool slot.
--
-- After these indexes: validate_token EXPLAIN dropped from 124ms (seq scan)
-- to 44ms, and the REST endpoint latency fell from ~90s (queued) to 450ms.

CREATE INDEX IF NOT EXISTS idx_user_tokens_token_lower
  ON user_tokens (LOWER(token))
  WHERE active = true;

CREATE INDEX IF NOT EXISTS idx_users_token_lower
  ON users (LOWER(token))
  WHERE active = true;
