# Phase 1 changes

1. Preventive Maintenance: removed the "Equipment maintenance coverage" box (frontend/static/js/29-pm-live-dashboard.js).
2. Washing plant overlay:
   - Site Engineer can report washing inside the overlay (date, Done / Not done, tables, before/after photos, remarks) and stays in the overlay after submitting. Missed days can be entered up to 45 days back.
   - Site Engineer can edit or delete their own report until O&M confirms it (a rejected report goes back to review once fixed).
   - O&M Head / washing Assignee can change any cycle deadline (and reset to the default 10th / 20th / month-end), edit or delete any report including older dates, and back-fill a missed report (saved as confirmed).
   - New API: PATCH /api/scheduled/washing/plants/{plant_id}/cycle-date, PATCH and DELETE /api/scheduled/washing/daily-reports/{id}; POST daily-reports accepts report_date.
3. DATABASE: run database/migrations/026_washing_cycle_date_overrides.sql (already appended to database/SUPABASE_RUN_THIS.sql) once before deploying.
