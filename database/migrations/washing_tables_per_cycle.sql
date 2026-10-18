-- Tables a plant washes in ONE cycle (3 cycles a month). A single number per plant.
-- It is only the target the washing compliance ratio is measured against; it is never a limit,
-- and individual tables are not tracked. Teams still report how many tables they cleaned each day.
ALTER TABLE washing_config ADD COLUMN IF NOT EXISTS tables_per_cycle integer;