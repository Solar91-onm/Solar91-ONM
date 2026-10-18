ALTER TABLE issue_history ADD COLUMN IF NOT EXISTS work_date date;
ALTER TABLE issue_history ADD COLUMN IF NOT EXISTS day_status varchar(80);
ALTER TABLE issue_history ADD COLUMN IF NOT EXISTS next_step text;
ALTER TABLE issue_history ADD COLUMN IF NOT EXISTS next_expected_on date;
ALTER TABLE issue_history ADD COLUMN IF NOT EXISTS review_state varchar(20);
ALTER TABLE issue_history ADD COLUMN IF NOT EXISTS reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE issue_history ADD COLUMN IF NOT EXISTS reviewed_by_name varchar(255);
ALTER TABLE issue_history ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;
ALTER TABLE issue_history ADD COLUMN IF NOT EXISTS review_note text;
ALTER TABLE issue_history ADD COLUMN IF NOT EXISTS review_on_behalf_of uuid REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS ix_issue_history_issue_work_date
    ON issue_history(issue_id, work_date);
CREATE INDEX IF NOT EXISTS ix_issue_history_issue_review_state
    ON issue_history(issue_id, review_state);

CREATE TABLE IF NOT EXISTS issue_steps (
    id uuid PRIMARY KEY,
    issue_id uuid NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    position integer NOT NULL DEFAULT 0,
    title varchar(255) NOT NULL,
    done boolean NOT NULL DEFAULT false,
    done_on date,
    done_at timestamptz,
    done_by uuid REFERENCES users(id) ON DELETE SET NULL,
    done_by_name varchar(255),
    remark text,
    removed_at timestamptz,
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_issue_steps_issue_position
    ON issue_steps(issue_id, position);

CREATE TABLE IF NOT EXISTS issue_etc_changes (
    id uuid PRIMARY KEY,
    issue_id uuid NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    old_etc timestamptz,
    new_etc timestamptz NOT NULL,
    reason text NOT NULL,
    changed_by uuid REFERENCES users(id) ON DELETE SET NULL,
    changed_by_name varchar(255) NOT NULL,
    changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_issue_etc_changes_issue_changed_at
    ON issue_etc_changes(issue_id, changed_at);

ALTER TABLE issues ADD COLUMN IF NOT EXISTS fixed_on date;
ALTER TABLE issues ADD COLUMN IF NOT EXISTS closed_on date;
UPDATE issues
SET fixed_on = COALESCE(
    fixed_on,
    NULLIF(COALESCE(closure->>'fixed_on', closure->>'fixedOn'), '')::date
)
WHERE closure IS NOT NULL;
UPDATE issues
SET closed_on = COALESCE(
    closed_on,
    CASE
        WHEN COALESCE(closure->>'closed_on', closure->>'closedAt', closure->>'closed_at') ~ '^\d{4}-\d{2}-\d{2}'
        THEN substring(COALESCE(closure->>'closed_on', closure->>'closedAt', closure->>'closed_at') from 1 for 10)::date
        ELSE NULL
    END
)
WHERE closure IS NOT NULL AND status = 'Closed';
