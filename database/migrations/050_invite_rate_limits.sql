-- ============================================================================
-- 050  Shared invite-email rate limits and bulk-import idempotency
-- ============================================================================
-- Rate-limit buckets store only hashed recipient keys and timestamps. Import
-- receipts store a payload hash and the bounded API response (which can include
-- row-level email values in validation errors). All access is through the
-- authenticated FastAPI database session.
--
-- Additive only. The app does NOT apply migrations at startup. Review and apply
-- on staging first, then use the controlled Supabase migration process.
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS invite_rate_limit_buckets (
    bucket_key varchar(128) PRIMARY KEY,
    events jsonb NOT NULL DEFAULT '[]'::jsonb,
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT invite_rate_limit_events_is_array
        CHECK (jsonb_typeof(events) = 'array')
);

CREATE TABLE IF NOT EXISTS invite_import_receipts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    payload_hash varchar(64) NOT NULL,
    status varchar(20) NOT NULL,
    response_json jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_invite_import_receipts_actor_payload UNIQUE (actor_id, payload_hash),
    CONSTRAINT invite_import_receipts_status_check
        CHECK (status IN ('processing', 'completed', 'failed'))
);

CREATE INDEX IF NOT EXISTS ix_invite_import_receipts_created
    ON invite_import_receipts (created_at);

ALTER TABLE invite_rate_limit_buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE invite_import_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE invite_rate_limit_buckets, invite_import_receipts FROM PUBLIC;
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        REVOKE ALL ON TABLE invite_rate_limit_buckets, invite_import_receipts FROM anon;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE ALL ON TABLE invite_rate_limit_buckets, invite_import_receipts FROM authenticated;
    END IF;
END $$;

COMMIT;
