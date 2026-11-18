-- Requirements tickets are separate from equipment/site issues so they do not
-- affect issue metrics or the Site Issues workflow.
BEGIN;

CREATE TABLE IF NOT EXISTS requirement_tickets (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_no varchar(40) NOT NULL UNIQUE,
    plant_id uuid REFERENCES plants(id) ON DELETE SET NULL,
    site_code varchar(80) NOT NULL,
    description text NOT NULL,
    demand_count integer NOT NULL,
    priority varchar(20) NOT NULL DEFAULT 'Medium',
    status varchar(20) NOT NULL DEFAULT 'Open',
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    completed_by uuid REFERENCES users(id) ON DELETE SET NULL,
    completed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ck_requirement_tickets_priority CHECK (priority IN ('Critical', 'Medium', 'Low')),
    CONSTRAINT ck_requirement_tickets_status CHECK (status IN ('Open', 'Completed')),
    CONSTRAINT ck_requirement_tickets_demand_count CHECK (demand_count >= 1)
);

CREATE INDEX IF NOT EXISTS ix_requirement_tickets_status_created
    ON requirement_tickets(status, created_at);
CREATE INDEX IF NOT EXISTS ix_requirement_tickets_plant_status
    ON requirement_tickets(plant_id, status);

ALTER TABLE requirement_tickets ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        REVOKE ALL ON TABLE requirement_tickets FROM anon;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE ALL ON TABLE requirement_tickets FROM authenticated;
    END IF;
END $$;

COMMIT;
