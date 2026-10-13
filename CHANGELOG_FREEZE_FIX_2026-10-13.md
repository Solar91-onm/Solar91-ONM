# Freeze / unresponsive-portal fix (2026-10-13)

Cause found: the Site Issues trend chart looped once per day between the From and To filter dates.
A half-typed date such as 0002-10-12 produced ~740,000 rows and froze the tab (stack overflow / hang).

Changes
- 00-auth-data-and-imports.js  issueTrendRows(): ignores invalid dates, years outside 2000-2100, caps the chart at 366 days.
- 22-site-issues-redesign.js   siSet(): rejects invalid From/To dates when they are set.
- 01-state-and-init.js         init(): clears any bad saved From/To date on start-up.
- 00-loop-guard.js             records render times, slow browser tasks and API timings. Console: s91Diagnose()
                               prints and copies a short report. Red "portal froze" box now has a Copy report button.
                               Traces more sub-steps (filterIssues, issueTrendRows, issueSpark, ...).
- templates/index.html         ?v= cache-bust tags bumped for the four changed scripts.

Verified: 195 pytest tests pass; every module opens with no errors on sample data and on a large dataset
(3,000 issues / 3,500 PM tasks / 4,800 washing tables / 1,710 equipment); 195 malformed-ticket fuzz cases did not
crash or slow Site Issues.
