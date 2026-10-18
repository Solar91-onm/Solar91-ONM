-- O&M Head can re-date a plant's washing cycle deadline (e.g. when it was set up by mistake).
-- Stored per plant as {"YYYY-MM": {"1": "YYYY-MM-DD", ...}}; an empty object means the default 10th / 20th / month-end.
ALTER TABLE washing_config ADD COLUMN IF NOT EXISTS cycle_overrides jsonb NOT NULL DEFAULT '{}'::jsonb;
