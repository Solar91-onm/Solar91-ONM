CREATE TABLE IF NOT EXISTS state_collection_revisions (
    collection VARCHAR(80) PRIMARY KEY,
    revision INTEGER NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE state_collection_revisions ENABLE ROW LEVEL SECURITY;
