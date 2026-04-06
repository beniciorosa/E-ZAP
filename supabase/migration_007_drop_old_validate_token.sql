-- Migration 007: Drop old validate_token overload (6 params)
-- Fix for PostgREST error 300: ambiguous function resolution
-- The old 6-param version was created before migration_006 added p_skip_log
-- Having two overloads (6 params and 7 params) caused PostgREST to fail
-- with "Could not choose the best candidate function"

DROP FUNCTION IF EXISTS public.validate_token(text, text, text, text, text, text);
