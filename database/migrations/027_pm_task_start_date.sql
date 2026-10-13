-- Preventive Maintenance tasks get a planned start date next to the existing due date (deadline).
-- O&M Head and the in-scope Assignee can edit both; Site Engineers cannot.
ALTER TABLE om_tasks ADD COLUMN IF NOT EXISTS start_on date;
