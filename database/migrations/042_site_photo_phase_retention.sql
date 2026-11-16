-- Washing photo slots and original-file retention metadata. Metadata rows and
-- thumbnails remain after full-resolution objects are purged.
BEGIN;

ALTER TABLE public.site_photos ADD COLUMN IF NOT EXISTS phase varchar(10);
ALTER TABLE public.site_photos ADD COLUMN IF NOT EXISTS slot smallint;
ALTER TABLE public.site_photos ADD COLUMN IF NOT EXISTS original_purged_at timestamptz;
ALTER TABLE public.site_photos ADD COLUMN IF NOT EXISTS thumbnail_size_bytes integer;
ALTER TABLE public.site_photos ADD COLUMN IF NOT EXISTS width integer;
ALTER TABLE public.site_photos ADD COLUMN IF NOT EXISTS height integer;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'site_photos_phase_check') THEN
        ALTER TABLE public.site_photos
            ADD CONSTRAINT site_photos_phase_check CHECK (phase IS NULL OR phase IN ('before', 'after'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'site_photos_slot_check') THEN
        ALTER TABLE public.site_photos
            ADD CONSTRAINT site_photos_slot_check CHECK (slot IS NULL OR slot BETWEEN 1 AND 2);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'site_photos_thumbnail_size_check') THEN
        ALTER TABLE public.site_photos
            ADD CONSTRAINT site_photos_thumbnail_size_check CHECK (thumbnail_size_bytes IS NULL OR thumbnail_size_bytes >= 0);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'site_photos_dimensions_check') THEN
        ALTER TABLE public.site_photos
            ADD CONSTRAINT site_photos_dimensions_check CHECK (
                (width IS NULL OR width > 0) AND (height IS NULL OR height > 0)
            );
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS ux_site_photos_washing_slot
    ON public.site_photos (link_type, link_id, phase, slot)
    WHERE link_type = 'washing' AND phase IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_site_photos_retention
    ON public.site_photos (created_at)
    WHERE original_purged_at IS NULL AND thumbnail_path IS NOT NULL;

ALTER TABLE public.site_photos ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        REVOKE ALL ON TABLE public.site_photos FROM anon;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE ALL ON TABLE public.site_photos FROM authenticated;
    END IF;
END $$;

COMMIT;
