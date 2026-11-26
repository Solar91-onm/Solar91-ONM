-- Migration 056: Per-checkpoint photos on PM checklists.
-- Additive; run in Supabase SQL editor BEFORE deploying the matching application.
-- No existing records are removed or status-reset.
BEGIN;

-- Link a photo to the specific checklist checkpoint it was taken for.
-- Nullable: photos uploaded without a checkpoint (e.g. from Photo Intelligence) are unaffected.
ALTER TABLE site_photos
    ADD COLUMN IF NOT EXISTS checklist_item_id TEXT;

-- Targeted read index: "all photos for this PM activity, keyed by checkpoint".
-- A partial index on link_type keeps it small and consistent with the existing link-lookup pattern.
CREATE INDEX IF NOT EXISTS ix_site_photos_pm_item
    ON site_photos (link_id, checklist_item_id)
    WHERE link_type = 'pm' AND checklist_item_id IS NOT NULL;

-- Backfill: assign a stable id to every item in already-submitted PM checklist activities.
-- (Unsubmitted activities have checklist = '[]'; they receive ids on first detail-view access in Python.)
-- No PM checkpoint photos exist yet — this is a new capability — so gen_random_uuid() is correct here.
-- The NOT EXISTS guard prevents double-application if this migration runs more than once.
UPDATE pm_tracking_activities
SET checklist = (
    SELECT jsonb_agg(
        c || jsonb_build_object('id', gen_random_uuid()::text)
        ORDER BY idx
    )
    FROM jsonb_array_elements(checklist) WITH ORDINALITY AS t(c, idx)
)
WHERE jsonb_array_length(checklist) > 0
  AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(checklist) AS x
      WHERE x ? 'id'
  );

COMMIT;
