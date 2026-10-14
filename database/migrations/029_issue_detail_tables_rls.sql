-- Issue work-step and deadline-change records are only accessed through FastAPI.
-- Prevent direct Supabase Data API access by client roles; the server's database
-- connection continues to use its configured PostgreSQL role.
ALTER TABLE IF EXISTS public.issue_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.issue_etc_changes ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.issue_steps, public.issue_etc_changes FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE public.issue_steps, public.issue_etc_changes FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE public.issue_steps, public.issue_etc_changes FROM authenticated;
  END IF;
END $$;
