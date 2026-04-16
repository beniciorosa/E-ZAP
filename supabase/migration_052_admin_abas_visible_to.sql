-- Migration 052: Add visible_to column to admin_abas
-- Array de user_ids que podem ver a aba. NULL = todos.

ALTER TABLE admin_abas ADD COLUMN IF NOT EXISTS visible_to TEXT[] DEFAULT NULL;
