-- Apply ONLY after staging backup, using the existing project migration process.
-- All photo metadata is accessed through Clerk-authenticated FastAPI; objects use the existing private Storage bucket.
CREATE TABLE IF NOT EXISTS public.site_photos (
 id uuid PRIMARY KEY, plant_id uuid NOT NULL REFERENCES public.plants(id) ON DELETE CASCADE,
 uploaded_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
 uploader_name varchar(255) NOT NULL, category varchar(40) NOT NULL,
 description text NOT NULL DEFAULT '', tags json NOT NULL DEFAULT '[]'::json,
 link_type varchar(30), link_id varchar(120), storage_path text NOT NULL,
 thumbnail_path text, file_name varchar(255) NOT NULL, content_type varchar(80) NOT NULL,
 size_bytes integer NOT NULL CHECK (size_bytes > 0), created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT site_photos_link_pair CHECK ((link_type IS NULL AND link_id IS NULL) OR (link_type IS NOT NULL AND link_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS ix_site_photos_plant_id ON public.site_photos(plant_id);
CREATE INDEX IF NOT EXISTS ix_site_photos_plant_created ON public.site_photos(plant_id, created_at DESC);
ALTER TABLE public.site_photos ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.site_photos FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN REVOKE ALL ON public.site_photos FROM anon; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN REVOKE ALL ON public.site_photos FROM authenticated; END IF;
END $$;
