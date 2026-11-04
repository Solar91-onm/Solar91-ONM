# Solar91 O&M — portal frontend

The portal design is the application. It is served at `/` behind the existing
Clerk sign-in, and it reads live data from Supabase through the authenticated,
role-scoped API.

This replaced the previous layered frontend bundle (52 JS + 35 CSS files) and the
standalone read-only portal prototype that used mock data.

## Layout

```
frontend/
├── templates/index.html         the page served at / (Jinja: Clerk config + build id)
└── static/
    ├── js/auth-gate.js          THE SIGN-IN PANEL — extracted unchanged; do not restyle
    ├── js/pwa.js                install prompt
    ├── css/login.css            sign-in panel styles, unchanged
    ├── brand/                   brand marks
    ├── pwa/                     manifest, icons, offline service worker
    └── templates/               PM / washing spreadsheet templates

assets/                          the portal design system, served at /assets
├── css/  tokens · layout · components · calendar · site-issues · settings · plant-details
└── js/
    ├── format.js                escaping, numbers, dates, CSV formula guard
    ├── portal-api.js            one authenticated route to the API (delegates to auth-gate)
    ├── data-adapter.js          the ONE place that fetches and aggregates
    ├── plant-details.js         The plant record editor (PATCH /api/plants/:id)
    ├── plants-table.js          Details: one plant's row, or the portfolio grid
    ├── site-issues.js           Health: the issue register and raise-issue flow
    ├── operations-calendar.js   PM and Washing calendars
    ├── categories.js            Settings → Categories (the work-category list)
    ├── settings.js              Settings page shell
    ├── navigation.js            sidebar, plant list, routing
    ├── overview.js              the Overview page
    └── app.js                   boots the portal after a successful sign-in
```

## Navigation

- **Overview** — portfolio tiles, Plant Health, PM and Washing compliance, a
  sortable comparison table, Critical Issues and Recent Activity.
- **Plants → <plant> →** Details · Health · Preventive Maintenance · Washing
- **Views →** Details (every plant) · Health · Preventive Maintenance · Washing
- **Details →** Design/MDL · Purchase · Liaisoning · BOM. Design/MDL retains the current plant details table; the other sections are empty until their data workflows are implemented.
- **Settings** — Team access, and **Categories** (the work-category list).

## Sign-in

`frontend/static/js/auth-gate.js` is the access panel, extracted byte-for-byte
from the previous bundle: the Clerk e-mail-code flow, token refresh, the single
401 retry before sign-out, and `apiFetch`. Only what boots *after* a valid
session changed.

Boot order, unchanged in shape:

```
ensureClerkReady() → no Clerk session ? showClerkSignIn()
                   → GET /api/auth/session → role gate → render the portal
```

A `Viewer` still gets the "access pending" card. `tests/test_sign_in_gate.py`
and `tests/test_code_signin.py` pin that behaviour.

## Where the data comes from

Every figure is read from the database. `assets/js/data-adapter.js` is the only
module that fetches; the UI depends on it alone.

| Endpoint | Gives |
|---|---|
| `GET /api/portal/overview` | every visible plant + its profile + portfolio totals, in one request |
| `GET /api/portal/plants` | the full stored plant records |
| `GET /api/portal/plants/{code}` | one plant: record, profile, recent activity |
| `GET /api/portal/activity` | recent real issue / PM events |
| `GET /api/portal/calendar` | dated PM or washing records for a month |
| `GET /api/categories` | the work-category list and each one's sub-problems |

Costs are bounded: the Overview is five grouped queries plus the washing
overview, whatever the plant count — never one request per plant.

Business rules are not re-implemented. `app/portal/service.py` names its source
for each: issue state sets and severity storage from `app/issues`, the PM status
set and overdue rule from `app/scheduled/router.py`, and washing compliance from
`app/scheduled/washing_cycles.py` itself.

**Missing data stays missing.** A plant with no records reads "Not available",
never `0` — a zero would look like good news.

## Scope

The server decides. `app/portal/service.py :: visible_plants` applies
`user_scoped_plant_ids`, so the browser never chooses what it may see.

- **O&M Head / Administration** — the whole portfolio
- **Assignee** — their assigned plants (one or more)
- **Site Engineer** — exactly one plant
- **Viewer** — access pending

## Categories, not an asset register

The per-asset equipment register was removed. What work is raised and planned
against is now a **work category** in the `work_categories` table: the category,
its sub-problems, how many a plant has, and your own identifier for it.

It ships **empty**. Fill it in **Settings → Categories** (any O&M Head or
Assignee) or in Supabase — see `database/migrations/033_work_categories.sql`.
Until one exists, the category dropdowns are empty and a new PM plan or issue
cannot pick one; Plants and Washing are unaffected.

## Still in the main O&M app

The portal covers reading, raising issues and editing plant records. These write
paths were not rebuilt in the new design and are not reachable from it:

- PM planning and schedule editing (`/api/pm-plan`, `/api/scheduled`)
- Washing setup, daily reports and review (`/api/scheduled/washing`)
- Issue workflow transitions after creation (`/api/issues/{id}/...`)
- Photo capture and the evidence gallery (`/api/photos`)
- Team invites and access changes (`/api/users`)

Their APIs are all intact and tested; only the screens are missing.

## Running it

```bash
pip install -r requirements.txt
cp .env.example .env          # Clerk + Supabase settings
uvicorn app.main:app --reload
```

Open <http://localhost:8000/> and sign in. Deployment is unchanged: same
`render.yaml`, same build and start commands, same environment variables.
