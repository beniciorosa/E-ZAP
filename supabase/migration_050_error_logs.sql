-- Migration 050: Error logs table for extension error tracking
-- Captura erros JavaScript da extensao para monitoramento

CREATE TABLE IF NOT EXISTS error_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  message TEXT,
  source TEXT,
  line_number INTEGER,
  col_number INTEGER,
  stack TEXT,
  ext_version TEXT,
  url TEXT,
  timestamp TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Index para consultar por usuario e data
CREATE INDEX IF NOT EXISTS idx_error_logs_user ON error_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_error_logs_timestamp ON error_logs(timestamp DESC);

-- Auto-cleanup: erros mais antigos que 30 dias (opcional, rodar via cron)
-- DELETE FROM error_logs WHERE timestamp < now() - interval '30 days';

-- RLS (service role bypasses)
ALTER TABLE error_logs ENABLE ROW LEVEL SECURITY;
