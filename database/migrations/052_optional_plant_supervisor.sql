-- Additive, rerunnable; execute before deploying the new application.
BEGIN;
ALTER TABLE public.plants ADD COLUMN IF NOT EXISTS supervisor varchar(160);
COMMIT;
-- NULL means not assigned. This is a display/contact name, NOT an account or an authorisation role.
