BEGIN;

CREATE INDEX IF NOT EXISTS ix_site_photos_link_created
    ON public.site_photos (link_type, link_id, created_at);

COMMIT;
