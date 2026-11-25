-- ============================================================================
-- 054  Notification centre: duplicate prevention and read-path indexes
-- ============================================================================
-- The `notifications` table itself already exists (migration 001) and keeps its
-- columns unchanged. This migration only makes the notification centre cheap and
-- safe to serve:
--
--   1. A partial UNIQUE index on (user_id, dedupe_key) so a retried request or two
--      concurrent workers cannot write the same notification twice. The application
--      already checks for an existing row; the index is what makes it a guarantee.
--   2. An index for the bell's unread count and its keyset-paginated list.
--   3. An index for the portal-wide broadcast rows (user_id IS NULL), which every
--      user's list unions in.
--
-- Category and priority are derived from `event_type` in the application
-- (app/notifications/service.py), so no column is added here and every row already
-- in the table is presented correctly.
--
-- Additive only: nothing is dropped, altered or deleted. SAFE TO RE-RUN.
-- Take a Supabase backup (or run on staging) first. Index builds hold a brief lock;
-- apply in a quiet window, or run the CREATE INDEX statements with CONCURRENTLY
-- outside this transaction if the table is large and busy.
-- ============================================================================
BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '600s';

-- 1. One notification per (user, dedupe_key). Rows without a key are unaffected.
--    If this fails, the table already holds duplicates: the SELECT below the COMMIT
--    lists them, and they must be resolved before the index can be created.
CREATE UNIQUE INDEX IF NOT EXISTS uq_notifications_user_dedupe
    ON notifications (user_id, dedupe_key)
    WHERE user_id IS NOT NULL AND dedupe_key IS NOT NULL;

-- 2. The bell: unread count and newest-first page for one recipient.
--    (ix_notifications_user_read from migration 002 stays; this one orders by
--     created_at for the keyset cursor and is partial, so it stays small.)
CREATE INDEX IF NOT EXISTS ix_notifications_user_unread
    ON notifications (user_id, created_at DESC)
    WHERE read_at IS NULL;

-- 3. Portal-wide broadcasts, which every recipient's query unions in.
CREATE INDEX IF NOT EXISTS ix_notifications_broadcast
    ON notifications (created_at DESC)
    WHERE user_id IS NULL;

-- Row level security and the revoked anon/authenticated grants from migration 004
-- already cover this table; the API is the only reader.
ALTER TABLE IF EXISTS notifications ENABLE ROW LEVEL SECURITY;

COMMIT;

-- Duplicates to resolve if step 1 was rejected (expected result: no rows):
SELECT user_id, dedupe_key, count(*) AS copies
FROM notifications
WHERE user_id IS NOT NULL AND dedupe_key IS NOT NULL
GROUP BY user_id, dedupe_key
HAVING count(*) > 1
ORDER BY copies DESC
LIMIT 50;
