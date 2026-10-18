\-- ============================================================================
-- SUPABASE: run this ONCE in  Supabase -> SQL Editor -> New query -> Run.
-- Adds the Preventive Maintenance and Washing workflow features
-- (unit workload planning, editable maintenance scope, plant washing cycles).
-- Safe to run more than once. It does NOT change or delete any existing data.
-- Includes per-collection legacy-state sync revisions for performance Step 1.
-- ============================================================================

-- PM unit-level scheduling: per-plant unit counts / daily capacity, unit fields on PM tasks.
-- Safe to run more than once. Existing rows are NOT modified (new columns are nullable / default 0).
CREATE TABLE IF NOT EXISTS pm_unit_config (
    id uuid PRIMARY KEY,
    plant_id uuid NOT NULL REFERENCES plants(id) ON DELETE CASCADE,
    equipment_type varchar(120) NOT NULL,
    total_units integer NOT NULL CHECK (total_units >= 1),
    units_per_day integer NOT NULL CHECK (units_per_day >= 1),
    updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (plant_id, equipment_type)
);
CREATE INDEX IF NOT EXISTS ix_pm_unit_config_plant ON pm_unit_config(plant_id);

ALTER TABLE pm_templates ADD COLUMN IF NOT EXISTS units_per_day integer;

ALTER TABLE om_tasks ADD COLUMN IF NOT EXISTS unit_no integer;
ALTER TABLE om_tasks ADD COLUMN IF NOT EXISTS total_units integer;
ALTER TABLE om_tasks ADD COLUMN IF NOT EXISTS cycle_id varchar(60);
ALTER TABLE om_tasks ADD COLUMN IF NOT EXISTS cycle_day integer;
ALTER TABLE om_tasks ADD COLUMN IF NOT EXISTS planned_due_on date;
ALTER TABLE om_tasks ADD COLUMN IF NOT EXISTS missed_days integer NOT NULL DEFAULT 0;
ALTER TABLE om_tasks ADD COLUMN IF NOT EXISTS rolled_count integer NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS ix_om_tasks_cycle_id ON om_tasks(cycle_id);

-- Same lock-down pattern as 010/011/013/015: only the FastAPI server touches this table.
ALTER TABLE IF EXISTS pm_unit_config ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE pm_unit_config FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE pm_unit_config FROM authenticated;
  END IF;
END $$;

-- Editable Maintenance Scope Library (O&M Head). One row; empty/absent = built-in defaults.
CREATE TABLE IF NOT EXISTS pm_scope_config (
    id uuid PRIMARY KEY,
    config jsonb NOT NULL DEFAULT '{}'::jsonb,
    updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE IF EXISTS pm_scope_config ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE pm_scope_config FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE pm_scope_config FROM authenticated;
  END IF;
END $$;

-- Reviewed plant-level washing reports and plant Assignee assignment.
ALTER TABLE washing_config
    ADD COLUMN IF NOT EXISTS assigned_user_id uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE washing_config ADD COLUMN IF NOT EXISTS compliance_threshold_percent integer NOT NULL DEFAULT 85;

CREATE TABLE IF NOT EXISTS washing_daily_reports (
    id uuid PRIMARY KEY,
    plant_id uuid NOT NULL REFERENCES plants(id) ON DELETE CASCADE,
    cycle_month varchar(7) NOT NULL,
    cycle_no integer NOT NULL,
    report_date date NOT NULL,
    job_status varchar(40) NOT NULL,
    tables_cleaned integer NOT NULL DEFAULT 0,
    cleaned_table_codes jsonb NOT NULL DEFAULT '[]'::jsonb,
    remarks text,
    exception_reason varchar(80),
    evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
    reported_by_id uuid REFERENCES users(id) ON DELETE SET NULL,
    reported_by varchar(255) NOT NULL,
    review_status varchar(40) NOT NULL DEFAULT 'Pending',
    reviewed_by_id uuid REFERENCES users(id) ON DELETE SET NULL,
    reviewed_by varchar(255),
    reviewed_at timestamptz,
    review_note text,
    cycle_completed boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE washing_daily_reports ADD COLUMN IF NOT EXISTS cleaned_table_codes jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE washing_daily_reports ADD COLUMN IF NOT EXISTS exception_reason varchar(80);
ALTER TABLE washing_daily_reports ADD COLUMN IF NOT EXISTS evidence jsonb NOT NULL DEFAULT '[]'::jsonb;
CREATE INDEX IF NOT EXISTS ix_washing_daily_reports_plant_month_cycle
    ON washing_daily_reports(plant_id, cycle_month, cycle_no);
ALTER TABLE IF EXISTS washing_daily_reports ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE washing_daily_reports FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE washing_daily_reports FROM authenticated;
  END IF;
END $$;

-- Washing setup imports: optional configuration notes/activity and batched report lookup.
ALTER TABLE washing_config ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;
ALTER TABLE washing_config ADD COLUMN IF NOT EXISTS notes varchar(500);
CREATE INDEX IF NOT EXISTS ix_washing_daily_reports_plant_date
    ON washing_daily_reports(plant_id, report_date);

-- Site issue daily work, work steps, ETC changes, and closure dates (migration 021).
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
CREATE INDEX IF NOT EXISTS ix_issue_history_issue_work_date ON issue_history(issue_id, work_date);
CREATE INDEX IF NOT EXISTS ix_issue_history_issue_review_state ON issue_history(issue_id, review_state);
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
CREATE INDEX IF NOT EXISTS ix_issue_steps_issue_position ON issue_steps(issue_id, position);
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
CREATE INDEX IF NOT EXISTS ix_issue_etc_changes_issue_changed_at ON issue_etc_changes(issue_id, changed_at);
ALTER TABLE IF EXISTS public.issue_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.issue_etc_changes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.issue_steps, public.issue_etc_changes FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE public.issue_steps, public.issue_etc_changes FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE public.issue_steps, public.issue_etc_changes FROM authenticated;
  END IF;
END $$;
ALTER TABLE issues ADD COLUMN IF NOT EXISTS fixed_on date;
ALTER TABLE issues ADD COLUMN IF NOT EXISTS closed_on date;
UPDATE issues SET fixed_on = COALESCE(fixed_on, NULLIF(COALESCE(closure->>'fixed_on', closure->>'fixedOn'), '')::date)
WHERE closure IS NOT NULL;
UPDATE issues SET closed_on = COALESCE(closed_on,
    CASE WHEN COALESCE(closure->>'closed_on', closure->>'closedAt', closure->>'closed_at') ~ '^\d{4}-\d{2}-\d{2}'
         THEN substring(COALESCE(closure->>'closed_on', closure->>'closedAt', closure->>'closed_at') from 1 for 10)::date
         ELSE NULL END)
WHERE closure IS NOT NULL AND status = 'Closed';

-- ============================================================================
-- PM follow-up tracking and quantity (migration 022).
ALTER TABLE om_tasks ADD COLUMN IF NOT EXISTS quantity integer;

-- PM planned start date (migration 027) and washing cycle start overrides live in the existing cycle_overrides column.
ALTER TABLE om_tasks ADD COLUMN IF NOT EXISTS start_on date;
CREATE TABLE IF NOT EXISTS pm_followups (
    id uuid PRIMARY KEY,
    task_id uuid NOT NULL REFERENCES om_tasks(id) ON DELETE CASCADE,
    at timestamptz NOT NULL DEFAULT now(),
    by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    by_name varchar(255) NOT NULL,
    how varchar(40) NOT NULL,
    spoke_to varchar(255),
    outcome varchar(80) NOT NULL,
    promised_on date,
    next_follow_up_on date,
    note text
);
CREATE INDEX IF NOT EXISTS ix_pm_followups_task_at ON pm_followups(task_id, at);
CREATE TABLE IF NOT EXISTS pm_due_changes (
    id uuid PRIMARY KEY,
    task_id uuid NOT NULL REFERENCES om_tasks(id) ON DELETE CASCADE,
    old_due date,
    new_due date NOT NULL,
    reason text NOT NULL,
    by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    by_name varchar(255) NOT NULL,
    at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_pm_due_changes_task_at ON pm_due_changes(task_id, at);
ALTER TABLE IF EXISTS pm_followups ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS pm_due_changes ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE pm_followups, pm_due_changes FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE pm_followups, pm_due_changes FROM authenticated;
  END IF;
END $$;

-- ============================================================================
-- PM alert ladder and per-user/per-plant notification preferences (migration 023).
CREATE TABLE IF NOT EXISTS pm_alert_log (
    id uuid PRIMARY KEY,
    task_id uuid NOT NULL REFERENCES om_tasks(id) ON DELETE CASCADE,
    level varchar(80) NOT NULL,
    due_on date,
    sent_at timestamptz NOT NULL DEFAULT now(),
    recipients_text text NOT NULL DEFAULT '',
    dedupe_key varchar(255) NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS ix_pm_alert_log_task_sent ON pm_alert_log(task_id, sent_at);
CREATE TABLE IF NOT EXISTS notification_preferences (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    module varchar(40) NOT NULL,
    plant_id uuid REFERENCES plants(id) ON DELETE CASCADE,
    preferences jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_notification_preferences_global
    ON notification_preferences(user_id, module) WHERE plant_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_notification_preferences_plant
    ON notification_preferences(user_id, module, plant_id) WHERE plant_id IS NOT NULL;
ALTER TABLE IF EXISTS pm_alert_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS notification_preferences ENABLE ROW LEVEL SECURITY;
CREATE TABLE IF NOT EXISTS state_collection_revisions (
    collection varchar(80) PRIMARY KEY,
    revision integer NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE state_collection_revisions ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE pm_alert_log, notification_preferences, state_collection_revisions FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE pm_alert_log, notification_preferences, state_collection_revisions FROM authenticated;
  END IF;
END $$;

-- ============================================================================
-- Migration 025: reversible Site Issue deletion (O&M Head only through API).
ALTER TABLE public.issues ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE public.issues ADD COLUMN IF NOT EXISTS deleted_by UUID REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE public.issues ADD COLUMN IF NOT EXISTS deletion_reason TEXT;
CREATE INDEX IF NOT EXISTS ix_issues_active_created ON public.issues(created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_issues_deleted_at ON public.issues(deleted_at DESC) WHERE deleted_at IS NOT NULL;

-- ============================================================================
-- CHECK (run after the above). Expect 7 PM scheduling fields on om_tasks, 1
-- on pm_templates, and the unit/scope/washing/follow-up tables listed.
-- ============================================================================
-- O&M Head can re-date a plant's washing cycle deadline (e.g. when it was set up by mistake).
-- Stored per plant as {"YYYY-MM": {"1": "YYYY-MM-DD", ...}}; an empty object means the default 10th / 20th / month-end.
ALTER TABLE washing_config ADD COLUMN IF NOT EXISTS cycle_overrides jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Tables a plant washes per cycle (migration 030): the target for the compliance ratio, never a limit.
ALTER TABLE washing_config ADD COLUMN IF NOT EXISTS tables_per_cycle integer;

SELECT table_name, column_name FROM information_schema.columns
WHERE (table_name = 'om_tasks' AND column_name IN ('unit_no','total_units','cycle_id','cycle_day','planned_due_on','missed_days','rolled_count','quantity'))
   OR (table_name = 'pm_templates' AND column_name = 'units_per_day')
ORDER BY table_name, column_name;

SELECT table_name FROM information_schema.tables
WHERE table_name IN ('pm_unit_config','pm_scope_config','washing_daily_reports','pm_followups','pm_due_changes','pm_alert_log','notification_preferences','state_collection_revisions','issue_steps','issue_etc_changes');