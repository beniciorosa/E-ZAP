-- ============================================================
-- Migration 008: Flow test trigger column
-- ============================================================
-- Permite ao admin disparar um teste manual de fluxo que sera
-- executado pela extensao na proxima sincronizacao

ALTER TABLE flows ADD COLUMN IF NOT EXISTS test_requested_at TIMESTAMPTZ;
ALTER TABLE flows ADD COLUMN IF NOT EXISTS test_processed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_flows_test_requested ON flows(test_requested_at) WHERE test_requested_at IS NOT NULL;
