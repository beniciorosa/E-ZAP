-- Migration 060: reset_token_device + atualiza reset_user_device
--
-- Contexto: a RPC antiga reset_user_device (migration 003) limpa apenas a
-- tabela legacy `users.token_redeemed/device_fingerprint/...`. Depois do
-- sistema migrar pra 1 user -> N tokens (tabela user_tokens, migration 032),
-- essa RPC ficou sem efeito pratico. O botao "Reset Disp." no admin nao
-- desbloqueava mais nada.
--
-- Esta migration cria a RPC por TOKEN individual (para o botao no admin no
-- card de cada token) e atualiza a RPC antiga pra limpar tambem user_tokens.

-- =============================================
-- RPC: reset_token_device (por token especifico)
-- =============================================
CREATE OR REPLACE FUNCTION reset_token_device(p_token_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE user_tokens SET
    token_redeemed = false,
    device_fingerprint = NULL,
    redeemed_ip = NULL,
    redeemed_location = NULL,
    redeemed_at = NULL,
    last_active = NULL
  WHERE id = p_token_id;
END;
$$;

-- =============================================
-- RPC: reset_user_device (atualizada — agora limpa user_tokens tambem)
-- =============================================
CREATE OR REPLACE FUNCTION reset_user_device(p_user_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  -- Legacy: limpa users.* (compat)
  UPDATE users SET
    token_redeemed = false,
    device_fingerprint = NULL,
    redeemed_ip = NULL,
    redeemed_location = NULL,
    redeemed_at = NULL
  WHERE id = p_user_id;

  -- Novo: limpa TODOS os tokens do usuario em user_tokens
  UPDATE user_tokens SET
    token_redeemed = false,
    device_fingerprint = NULL,
    redeemed_ip = NULL,
    redeemed_location = NULL,
    redeemed_at = NULL,
    last_active = NULL
  WHERE user_id = p_user_id;
END;
$$;
