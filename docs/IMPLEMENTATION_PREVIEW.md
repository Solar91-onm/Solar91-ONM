# Implementation Preview / Handoff

## Ready in this package

- Equipment Register v2 migration, fields, API, role scoping and audit logging.
- Atomic bulk add; XLSX/CSV template, dry-run preview and commit; filtered Excel export.
- Per-item in-charge plus existing type owners; in-charge notification override without changing Assignee visibility.
- Detail drawer for overview, assignment history, PM tasks, issues/metrics and documents.
- Server pagination, persisted/shareable filters, completeness shortcuts, warranty/service information, Move, Retire and typed permanent delete.
- Plant-detail equipment link and PM/Issue equipment suggestions with free-text fallback retained.
- Site Engineer remains plant-scoped and has no Equipment sidebar/mobile shortcut.
- Mobile **More** navigation contains Equipment Register for roles that can browse it.
- Initial loading skeleton, long caching for versioned static files, focus/scroll restoration, background interval pausing, keyboard modal safety, reduced-motion/focus styles and hash navigation.
- Washing UI is left visually intact and continues to use the existing table-level mapping/logging/exception/history/compliance workflow from the supplied specification.

## Files intentionally left alone

- Historical migrations 001–012 are untouched.
- Existing public API fields/routes, global JS function names and script order are retained.
- No CSS framework, font, bundler or build step was introduced.
- The existing equipment status vocabulary remains `active / maintenance / fault / inactive`.
- Existing Assignee type visibility is unchanged.

## Optional next UI pass

The safest production handoff is included now. A later visual-only pass can further collapse secondary controls on Preventive Maintenance and Site Issues and measure each wrapper/MutationObserver with browser performance traces. Those changes are deliberately not mixed into this data/API release because they are higher regression risk and are not required for the Equipment/Washing functionality to work.

## Verification

`pytest -q`: **49 passed**.

Every file in `frontend/static/js/` also passes `node --check`.
