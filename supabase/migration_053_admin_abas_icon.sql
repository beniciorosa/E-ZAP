-- Migration 053: Add icon column to admin_abas
-- Permite admin escolher um \u00edcone (emoji) que aparece no lugar do dot colorido

ALTER TABLE admin_abas ADD COLUMN IF NOT EXISTS icon TEXT DEFAULT NULL;
