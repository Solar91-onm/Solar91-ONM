# Supabase changes for this release

Everything you need to do on the Supabase side, in order. Nothing here touches
authentication, Clerk, `users`, roles or `role_permissions` — the sign-in and
access panel are unchanged by this release.

---

## 1. Run two migrations, in order

| Order | File | What it does |
|---|---|---|
| 1 | `database/migrations/032_remove_equipment_register.sql` | Removes the equipment register and moves Assignee scope to plants |
| 2 | `database/migrations/033_work_categories.sql` | Creates the (empty) `work_categories` table your new list goes into |

Paste each into **Supabase → SQL Editor** and run it. Both are safe to re-run.

Before you do:

- [ ] Take a backup (**Database → Backups**), or run it on staging first.
- [ ] Read step 3 below — some Assignees may need their plants set afterwards.

What it does, in the order it does it:

| Step | Action |
|---|---|
| 1 | Copies everything it will drop into a new `archive_032` schema (RLS on, `anon`/`authenticated` revoked) |
| 2 | **Migrates Assignee scope from equipment types to plants** — the only step that changes access |
| 3 | Drops `equipment`, `equipment_documents`, `user_equipment_assignments`, `user_equipment_type_assignments` |
| 4 | Drops `issues.equipment_id`, `issues.equipment_ref`, `issues.maker`, `om_tasks.equipment_ref`, and strips `supplier` / `serial_number` / `units` out of `issues.legacy_payload` |

It ends by printing any Assignee left without a plant.

---

## 2. Your new equipment list goes in `work_categories`

Migration 033 creates the table your clean list belongs in. It ships **empty** —
the old hard-coded list of 32 categories was removed with the register, because
it was the same incomplete, inconsistent list.

One row per category, holding exactly what you described:

| Column | Holds |
|---|---|
| `name` | the category, e.g. `Inverter` |
| `code` | **your own ID** for it, e.g. `INV` |
| `sub_problems` | **the sub-problems** for it, as a JSON array: `["Fan failure","IGBT fault"]` |
| `default_units` | **how many** a plant typically has |
| `area` | `Plant side` or `GSS side`, for the 30-day PM cycle |
| `sort_order` | the order it appears in every dropdown |
| `active` | uncheck instead of deleting, to keep old tickets readable |

**Two ways to fill it, both writing the same rows:**

1. **In Supabase** — there's a ready-made `INSERT` at the bottom of
   migration 033. Edit the values and run it. Re-running updates in place.
2. **In the portal** — **Settings → Categories**. Any **O&M Head or Assignee**
   can add, edit, reorder and deactivate categories there, with the
   sub-problems entered one per line. Saved immediately; no deploy needed.

Until at least one category exists:

* every category dropdown is empty, and a new PM plan or issue cannot pick one;
* the issue spreadsheet upload says *"No issue categories are configured yet"*
  rather than inventing a category;
* **Plants and Washing are unaffected** and work normally.

Per-plant unit counts stay where they already were, in `pm_unit_config`
(Preventive Maintenance → unit configuration). `default_units` above is only the
suggested starting number for a plant.

---

## 3. Tables after the migration

**Dropped (4):**

```
equipment
equipment_documents
user_equipment_assignments
user_equipment_type_assignments
```

**Columns dropped:**

```
issues.equipment_id      -- FK to equipment
issues.equipment_ref     -- free-text asset reference
issues.maker             -- asset maker
om_tasks.equipment_ref   -- free-text asset reference
```

**Added:**

```
work_categories                 -- your equipment list: categories, sub-problems, counts, IDs
```

**Kept deliberately — these reference a category, not an asset:**

```
issues.vertical                 -- the work category a ticket is raised against
issues.subcategory              -- the sub-problem, from that category's list
om_tasks.task_type              -- the work category a PM job maintains
pm_templates.equipment_type     -- column name kept for schema compatibility
pm_unit_config.equipment_type   -- column name kept for schema compatibility
pm_unit_config.total_units      -- now the ONLY source of PM unit counts
```

These hold a category name as plain text, matched against `work_categories`.
They keep their column names so no PM data or saved spreadsheet import has to
change. A ticket raised before a category is renamed keeps reading the way it
was raised, which is why a category already in use is deactivated rather than
deleted.

---

## 4. Re-assign Assignee plants (the one thing to check)

**This is the only behavioural change to access, so it's worth understanding.**

Before: an Assignee held equipment **types** (e.g. "Inverter"), and holding any
type exposed **every plant** in the portfolio.

After: an Assignee holds **plants**, as explicit rows in
`user_plant_assignments`. They may hold several (unlike a Site Engineer, who is
still limited to exactly one).

The migration keeps everyone working by giving each active Assignee **every
plant they could already see**. That preserves current behaviour exactly, but it
is wider than most teams want, so afterwards:

1. Open **Settings → Team access** in the portal.
2. For each Assignee, remove the plants they are not responsible for.

That is a tightening of access, never a widening, so it is safe to do gradually.

Run the migration's closing query any time to find Assignees with no plants —
they see the "access pending" screen until an O&M Head assigns them:

```sql
SELECT u.display_name, u.email
FROM users u
WHERE u.role = 'Assignee' AND u.is_active
  AND NOT EXISTS (SELECT 1 FROM user_plant_assignments a WHERE a.user_id = u.id);
```

---

## 5. Fill in the plant details (optional, but the new page reads them)

The new **Plants → Details** page shows the stored plant record. It shows
"Not available" for anything empty rather than inventing a value, so any column
you fill in appears immediately. These are the ones worth checking:

```sql
SELECT site_code, plant_name,
       district, discom, location, latitude, longitude,
       dc_capacity_kw, ac_capacity_kw, commissioned_on, status, project_company
FROM plants
ORDER BY plant_name;
```

| Column | Used for |
|---|---|
| `district`, `discom` | Location & grid card; the portfolio table's district filter |
| `location` | Location card |
| `latitude`, `longitude` | Coordinates, and an exact "Open map" link (otherwise the map falls back to a name search) |
| `dc_capacity_kw`, `ac_capacity_kw` | Capacity tiles, DC/AC ratio, portfolio MW totals |
| `commissioned_on` | COD and the derived plant age |
| `status` | The status chip; a non-`active` plant with no records reads as "Not yet commissioned" |
| `project_company` | SPV / project column, shortened to "Project 29" in tables |

You can fill these in from the portal itself (**Edit details** on any plant, for
roles with `plants.manage`) — no SQL needed.

Site Engineers shown on a plant come from `user_plant_assignments`, not from the
free-text `plants.assigned_engineer`. The free-text value is only displayed as a
fallback, and is never used for access.

---

## 6. Storage

Nothing to do, but worth knowing: equipment documents used to be stored under
`equipment/<id>/...` in your private Storage bucket. Dropping
`equipment_documents` removes the database rows but **not** the files. To find
and remove them, list the bucket and delete that prefix:

**Supabase → Storage → (your bucket) → `equipment/`**

Leave it in place if you'd rather keep the old documents; nothing reads it any
more, and `scripts/ensure_storage.py` doesn't check for it.

---

## 7. Nothing else changes

- **One new table** (`work_categories`, above). The portal API otherwise reads
  existing tables through new endpoints.
- **No RLS change needed.** The new `/api/portal/*` routes go through the same
  FastAPI → PostgreSQL connection as every other route, and scope is applied
  server-side in `app/portal/service.py :: visible_plants`. RLS stays as
  migration 004 set it: enabled with no `anon`/`authenticated` policies.
- **No index needed for the portal API.** Its queries group by `plant_id` on
  `issues` and `om_tasks`, which the existing indexes already cover. If the
  Overview gets slow once you're past a few hundred thousand tickets, these are
  the two to add:
  ```sql
  CREATE INDEX IF NOT EXISTS ix_issues_plant_status   ON issues(plant_id, status);
  CREATE INDEX IF NOT EXISTS ix_om_tasks_plant_status ON om_tasks(plant_id, status);
  ```
- **`render.yaml` and all Render settings are untouched.** Same build command,
  same start command, same environment variables.

---

## 8. Dropping the backup

Once the release is confirmed healthy in production:

```sql
DROP SCHEMA archive_032 CASCADE;
```

Until you run that, every dropped row is still recoverable from `archive_032`.
