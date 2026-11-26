-- Migration 057: add a dedicated written address for the Plants Info table.
-- The legacy `location` value remains unchanged for existing data; it is not safe to
-- assume that a city/place name is a complete postal address.
-- Additive, nullable for existing plants, safe to re-run.
BEGIN;
ALTER TABLE public.plants ADD COLUMN IF NOT EXISTS address text;
COMMIT;
