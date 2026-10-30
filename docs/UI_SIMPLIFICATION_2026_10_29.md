# Solar91 O&M — Simplified navigation, Site Issues and PM UI

Release date: 29 October 2026. Applies to the supplied source bundle; no hosted system was modified.

## Main navigation (previously prepared)
- The separate Command Center entry is removed from the primary navigation.
- The Plants menu lists **Plants table** before **Plants dashboard**.
- The Plants dashboard has an all-plant selector with searchable plant names / codes in the sidebar.
- Dashboard cards for **PM on schedule**, **Washing compliance** and **Site issues resolved** open the relevant operational module, retaining the plant scope or clearing it for all plants.
- Dedicated Site Issues and Preventive Maintenance sidebar links were removed to reduce clutter; workflows remain reachable through the dashboard and direct routes.

## Site Issues (this revision)
The default register is a **flat, searchable, filterable list** with a centered nine-column table:

1. Issue ID (severity shown quietly beneath the ID)
2. Equipment (existing issue equipment type)
3. Subpart (existing issue subcategory)
4. Problem (issue description)
5. Plant code (plant site code; name appears underneath)
6. Supplier / maker (stored supplier, otherwise manufacturer)
7. Assigned to (assignee or unassigned)
8. Status (red/green/neutral indicator; deadline text underneath)
9. Action (existing View/Assign/Reassign/Plant actions unchanged)

No full-row overdue coloring; overdue is a small status indicator and subtitle. Optional grouping and existing board/sites views remain available. The table scrolls **within its container** on narrow mobile screens; each cell stays readable and all columns remain accessible. Existing batch assignment, search/filter, ticket conversation, permissions and server actions remain unchanged.

The Raise Issue form keeps the **Subpart / fault area** separate from **Issue details**: choose the affected equipment area in the former and describe the full observed problem in the latter. If a saved legacy subpart exactly repeats the problem text, the register leaves the redundant subpart cell blank; new and edited tickets do not save an exact duplicate.

**Data limitation:** Equipment or unit references remain in the underlying issue records and issue details, but are no longer duplicated in the register as a separate column. The current API has no *separate nested subpart-ID field*; stored equipment references must not be treated as verified subcomponent serial IDs. Adding independent subpart IDs and editable hierarchies requires a separate, reviewed schema/API/form upgrade.

## Preventive Maintenance (this revision)
- Centered, consistent table headings and cell values in PM work register and daily planner.
- Subtler row highlights: overdue uses a small red status indicator, not a large red row.
- Progress bars, dates and ownership information remain visible and aligned.
- Assignment, detail drawers, unit-level records, evidence, follow-ups and action buttons remain unchanged.
- On narrow screens the PM register scrolls internally, and view tabs remain horizontal and reachable.

## Files
- `frontend/static/js/22-site-issues-redesign.js` — table fields, status presentation and flat-list default.
- `frontend/static/css/53-simple-issues-pm.css` — scoped layout, PM/Issues status, mobile table rules.
- `frontend/templates/index.html` — loads the new stylesheet.
- `tests/test_simple_issue_pm_ui.py` — new table, status, field order and PM integration checks.
- `scripts/browser_smoke.py` — updated to expect the new dashboard and verify table columns, internal mobile scrolling, and live issue actions with a test database.

## Validation and deployment
- Focused frontend and navigation tests run with `pytest`; a separate browser smoke passed with local test-only SQLite, including issue lifecycle changes, persistence, mobile scrolling and zero uncaught page exceptions.
- PM browser smoke passed for plant filtering, unit-level drilldowns and mobile switching.
- No live Clerk, Supabase, Render, iOS PWA, or physical device testing was performed. Verify these in staging before production.
- Run the existing deployment checks and back up the existing environment. These changes do not require a database migration.
