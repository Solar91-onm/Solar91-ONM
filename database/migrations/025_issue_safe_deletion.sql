-- Run once in Supabase SQL editor before deploying this release.
-- Soft-delete keeps ticket work history and private evidence intact.
ALTER TABLE public.issues ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE public.issues ADD COLUMN IF NOT EXISTS deleted_by UUID REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE public.issues ADD COLUMN IF NOT EXISTS deletion_reason TEXT;
CREATE INDEX IF NOT EXISTS ix_issues_active_created ON public.issues(created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_issues_deleted_at ON public.issues(deleted_at DESC) WHERE deleted_at IS NOT NULL;
