# Performance optimization report — 2026-10-29

Scope: WebP photo pipeline, query/payload overhead, compression, list sizes. All numbers are **local**: FastAPI
TestClient + isolated synthetic SQLite (`scripts/benchmark_api_latency.py`, synthetic Assignee user, 10 warm runs).
They are not Supabase/PostgreSQL, Render or browser timings. **No PostgreSQL staging, EXPLAIN plans, Render metrics or
concurrent-user load test were available, so none of those were run.** Capacity targets (p95 ≤ 1 s at 100 users)
remain unverified.

## Baseline vs. after

Synthetic 5x data (2,500 issues, 1,875 PM tasks, 1,250 washing tables), p50:

| Request | Before | After |
| --- | --- | --- |
| `/api/state/collections?keys=issues` | 28 queries, 508 ms app, 1.70 MB | 12 queries, 244 ms app, 1.70 MB (95 KB gzip) |
| Live refresh after an issue change (`34-live-refresh.js`) | `/api/bootstrap?lite=1`: 33 queries, 383 ms, 2.86 MB (120 KB gzip) | `state/collections?keys=plants,events,issues,equipment`: 13 queries, 234 ms, 1.74 MB (98 KB gzip). A PM-only change no longer re-downloads issues, and vice versa |
| Photo gallery, page *n* | refetched pages 1…*n* from offset 0 (60·*n* rows, ~7 queries per 120 rows) | one keyset page of 60 rows; further pages skip the count, facet and day-total queries (7 queries for the first page including sign-in/scope checks, fewer for the next — `tests/test_photo_paging.py`) |
| Photo upload, 10 photos | all originals + thumbnails held in memory together (up to ~150 MB of input) | one photo in memory at a time; DB connection returned during decoding/Storage |
| Evidence/document downloads | pooled DB connection held during the Storage download | connection returned before Storage I/O |

10x data (10,000 issues, 7,500 PM tasks): issues collection 917 ms / 6.8 MB (369 KB gzip); live refresh 951 ms
vs. lite bootstrap 1,818 ms (377 KB vs. 448 KB transferred). Full bootstrap: 1,969 ms, 12.7 MB decoded, 484 KB gzip —
**unchanged; still the largest single cost** (see Outstanding).

### Serialisation and compression (`scripts/benchmark_json.py`, 15,000 PM-like rows)

- FastAPI default (`jsonable_encoder` + `JSONResponse`): 1,231 ms; `app/core/fastjson.json_response`: 267 ms, identical
  JSON. `json_response` is now also used by the photo list, `state/collections` and `/api/tasks|handovers|washing`.
  orjson was not installed and is not added: the remaining cost is building rows, not encoding them.
- gzip on real-shaped payloads (5x): level 9 was 3–8% smaller than level 6 for 2–2.7x the CPU (sign-in 130 → 120 KB,
  27 → 73 ms). Level 6 is used (`app/core/compression.py`); images, PDFs and spreadsheets are no longer gzipped.
  Brotli was not adopted: it needs a new dependency and gzip already reduces JSON ~25x.

### WebP (representative synthetic photos, `tests/test_photo_webp_pipeline.py`)

| Source | Stored WebP | Thumbnail |
| --- | --- | --- |
| 4032×3024 JPEG q92, 4.85 MB | 279 KB (2048 px) | 1 KB |
| 1920×1080 JPEG q85, 592 KB | 510 KB | 2 KB |
| 1280×960 JPEG q80, 286 KB | 284 KB | 11 KB |

Savings depend on the photo; most come from limiting display copies to 2048 px. No fixed percentage is claimed.

## What changed

| Area | Files |
| --- | --- |
| Server WebP pipeline: decode-validated, EXIF orientation, EXIF/XMP/GPS stripped, alpha kept, PNG → lossless WebP, never upscaled, configurable (`PHOTO_MAX_SIDE`, `PHOTO_WEBP_QUALITY`, `PHOTO_THUMB_SIDE`, `PHOTO_THUMB_QUALITY`, `PHOTO_WEBP_METHOD`); phone-made WebP within limits stored as is | `app/photos/imaging.py`, `app/photos/router.py`, `app/core/config.py` |
| One-photo-at-a-time upload, compensating Storage removal, duplicate-submission replay | `app/photos/router.py`, `app/core/models.py`, `database/migrations/031_site_photo_submissions.sql`, `47-photo-intelligence.js`, `49-photo-live-adapter.js` |
| Keyset cursor for the gallery (`cursor`, `has_more`, `next_cursor`; offset capped at 5,000); 300 ms search debounce; superseded requests aborted | `app/photos/router.py`, `47-photo-intelligence.js`, `49-photo-live-adapter.js` |
| Phone-side WebP for Issue/PM/washing/photo uploads | `08-actions-exports-and-submission.js`, `26-washing-cycles.js` |
| Collections built on demand (`load_state(only=…)`) | `app/core/legacy_state.py`, `app/operations/router.py` |
| Module-scoped live refresh | `34-live-refresh.js` |
| Identical concurrent GETs share one request (callers get separate copies) | `00-auth-data-and-imports.js` |
| `release_connection()` before Storage I/O | `app/core/database.py`, issues/scheduled/plants/photos routers |
| Text-only gzip level 6 | `app/core/compression.py`, `app/main.py` |
| Smaller lists: washing day summary (50 + Show more), PM task-record drawer (40 + Show more); plant-link repair uses lookup maps | `26-washing-cycles.js`, `29-pm-live-dashboard.js`, `08-actions-exports-and-submission.js` |
| Benchmarks: transfer (gzip) bytes, live-refresh and photo endpoints; serializer benchmark | `scripts/benchmark_api_latency.py`, `scripts/benchmark_json.py` |

Old JPEG/PNG photo objects and thumbnails are not converted and keep working (content type comes from Storage).

## Deployment checklist

1. Back up staging; apply `030_site_photos.sql` (if not yet applied) and then `031_site_photo_submissions.sql`.
   **031 must be applied before this code is deployed**: the photo endpoints select the new columns.
2. Install requirements (`Pillow==12.3.0`, WebP support is built in).
3. Optional settings: `PHOTO_MAX_SIDE` (2048), `PHOTO_WEBP_QUALITY` (80), `PHOTO_THUMB_SIDE` (640),
   `PHOTO_THUMB_QUALITY` (70), `PHOTO_WEBP_METHOD` (4).
4. On staging: upload JPEG/PNG/WebP from Android and iPhone; retry an upload with poor connectivity (must not
   duplicate); scroll the gallery past several pages; open older JPEG photos; check an issue change appears in a
   second browser within ~30 s.
5. Watch Server-Timing / slow-request logs for `/api/state/collections`, `/api/photos` and photo uploads.

**Rollback:** redeploy the previous build. Migration 031 is additive (nullable columns + an index) and can stay.
WebP objects written meanwhile remain readable by the old code (it serves the stored content type).

## Connection budget

One Uvicorn worker (`scripts/render_start.sh`) × one Render instance × (`DB_POOL_SIZE` 5 + `DB_MAX_OVERFLOW` 2)
= **7 connections**, plus migrations/admin tools. Compare with the Supabase session-pooler limit in the dashboard
before adding workers or instances; each one adds 7. Requests beyond 7 wait up to `DB_POOL_TIMEOUT_SECONDS` (30 s).
Storage downloads/uploads no longer hold a connection, which was the main avoidable cause of pool waits.

## Known limits and outstanding work

- **Full bootstrap** (Phase 2.1): every legacy view reads `S.issues/S.tasks/S.washing/...` loaded at sign-in.
  A lightweight versioned bootstrap only helps once each screen reads paged APIs; that migration must be done
  screen by screen behind a flag and was not attempted blind. Next step: issues register → `/api/issues` (already
  paged/scoped), then PM (`/api/scheduled/tasks` with paging), then washing; keep exports on separate full endpoints.
- Live refresh still replaces the whole changed collection. A `since=` delta (with deletion and scope-change
  handling) would cut the 10x issues refresh from ~370 KB.
- Indexes: candidates `site_photos(link_type, link_id)` (ticket photo counts, linked filter) and pg_trgm for
  photo/issue text search — **not added**; they need EXPLAIN (ANALYZE, BUFFERS) on staging first.
- SQLite stores the API-created `created_at` without fractional seconds in some cases; keyset paging is exact on
  PostgreSQL (`timestamptz`) and photos now get their time in Python.
- Static assets: 49 JS files (1.59 MB, 492 KB gzip) and 31 CSS files (441 KB, 110 KB gzip) at first sign-in, then
  cached immutably. Bundling/minification needs a build step that preserves the global script order; deferred.
- Phone-side re-encoding removes EXIF time/GPS; the server records upload time and uploader. HEIC is not decoded
  server-side (no tested decoder added); browsers that can decode it convert it before upload, others show the
  existing unsupported-format message.
- Storage and PostgreSQL are not one transaction: if the process dies between Storage upload and commit, objects
  can be orphaned (no metadata row). They are private and unreferenced; a periodic cleanup of `site-photos/` objects
  without a row is not implemented.
- Ask Solar91 already meets the limits (≤ 40 scoped records, 501-row scan cap, 450 output tokens, 12 s timeout,
  `store: false`, opt-in `AI_ASSISTANT_ENABLED`); unchanged.
