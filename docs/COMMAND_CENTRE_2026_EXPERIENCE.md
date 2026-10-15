# Solar91 O&M — 2026 Command Centre experience

## Scope

Updated the existing FastAPI / Supabase application. The original header, sidebar, database schema, API routes and operational handlers remain in place. This is **not** the offline mockup.

### Command Centre

- Coloured operational queues based on loaded records: Open tickets, Critical faults, Overdue tickets, PM overdue, Washing due and Washing reports awaiting review.
- Selecting a queue opens its corresponding module with an appropriate filter and scrolls to the **register**, visibly highlighting it. The existing Site Issues and PM dashboard donut/chart drill-downs are also connected to the register.
- Washing overdue filters only plants with an overdue cycle. Washing review filters reports awaiting confirmation.
- Original dashboard visualizations and charts are retained after the new command strip.
- Existing topbar notification bell, workflow emails, report modules, and backend authorization rules remain unchanged.

### Layered operational reporting

- Compact side panel on the Command Centre with Daily, Weekly, Monthly, Open issues and Overdue reports.
- Read-only previews show up to 12 rows with explicit notice if more exist; Full Reports navigates to the original Reports screen.
- Download CSV, export Excel (uses the application's existing on-demand XLSX loader), and browser Print / PDF.
- Excel/CSV cells that begin with spreadsheet formula operators are escaped to reduce formula-injection risks.
- A successful download message reflects client-side file preparation; no claim about an email being sent.

### Ask Solar91

- A free, read-only operational search for O&M Head, Assignee, and Administration accounts. It is hidden for other roles.
- Searches the records available to the signed-in role across plants, equipment, tickets, PM, washing, and other accessible modules. Assignee data follows the server-provided equipment scope; Administration is limited to Command Center/Reports data; O&M Head can search portfolio and management records.
- Accepts natural-language questions, IDs, names, equipment types, plant/site codes, dates, and status terms; reports matching counts and up to 20 matching records with the searchable details.
- Provides quick prompts and links to existing filtered registers. Those links only navigate; they do not change records.
- Search and matching run locally over data already loaded by the application. No paid AI key, third-party AI service, assistant backend request, email, ticket creation, or task mutation is used. It is rule-based search rather than a generative model, so answers are limited to available records and loaded data.
- Hidden when logged out; chat history is cleared on sign-out. No chat history is uploaded.

### Feedback and styling

- Solar91 green with solar gold and purposeful red / amber / blue / teal queue status accents.
- Improved hover / focus, labels, spacing, button hierarchy and success/error/info toast treatment.
- Responsive desktop and mobile behavior, plus reduced-motion preferences.

## Verification

- Run backend suite: `APP_ENV=test PM_DAILY_JOB=0 pytest -q`.
- JavaScript syntax: `for f in frontend/static/js/*.js; do node --check "$f"; done`.
- Browser smoke test: install development dependencies with `python -m pip install -r requirements-dev.txt`, install the Playwright-managed browser with `python -m playwright install chromium`, then run `python scripts/verify_command_experience.py`. The test uses the managed Chromium build on Windows, macOS, and Linux; Linux CI installs its system dependencies automatically.
- Check in deployed environment: sign in through Clerk email code; confirm Supabase data and access-scoped counts, queue navigation, print/Excel/CSV exports, notification/email delivery configuration, and real task/ticket mutations.

## Deployment limitations

No production Supabase credentials were bundled or used. Local backend tests and simulated browser interactions **do not establish** that live database connectivity, email delivery or login will work in the production environment. Follow `RELEASE_VALIDATION.md` and verify with the site's secrets after deployment.
