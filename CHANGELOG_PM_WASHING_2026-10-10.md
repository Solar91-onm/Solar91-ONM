# Washing / PM updates — 10 October 2026

- Removed the duplicated day-by-day cleaning section from the main Washing view, preserving plant overlays and reporting.
- PM now displays an API-backed plant/equipment unit-coverage matrix, including equipment categories without scheduled work.
- Preserved the HTML-reference PM dashboard and site-issues workflow, app shell, Reports, and Supabase integration. (This historical entry predates the Supabase-only Auth migration.)
- PM task wizard prefills the currently selected plant and equipment category; unit counts are editable through the existing PM unit configuration workflow.
- Added CSV import using the existing validated dry-run and atomic backend importer; retained Excel import. Downloadable CSV template in UI and docs.
- Scoped unit-config API results to the authenticated user's permitted plant/equipment scope.
- Automated regression: 150 tests passed, JavaScript syntax validation passed, Chromium UI smoke passed.

See `docs/PM_CSV_AND_UNIT_COVERAGE.md` and `RELEASE_VALIDATION.md` for instructions and limitations.
