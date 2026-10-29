-- Additive, after 030_site_photos.sql. Apply ONLY after a staging backup, with the existing migration process.
-- Lets a retried / double-tapped Photo Intelligence upload return the photos already saved instead of storing duplicates.
ALTER TABLE public.site_photos ADD COLUMN IF NOT EXISTS submission_id uuid;
ALTER TABLE public.site_photos ADD COLUMN IF NOT EXISTS submission_index integer;
-- NULL submission ids (older clients, earlier rows) never conflict: PostgreSQL unique indexes treat NULLs as distinct.
CREATE UNIQUE INDEX IF NOT EXISTS ux_site_photos_submission
  ON public.site_photos (uploaded_by, submission_id, submission_index);
