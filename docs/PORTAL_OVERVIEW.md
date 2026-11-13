# Portal Overview

- Plant, Project, and District choices show all values available to the signed-in user and do not narrow one another. Overview access is portfolio-wide for O&M Head, Assignee, and Administration; Site Engineers remain restricted to assigned plants.
- The default Overview range is This month. Summary tiles and trends use the selected date range.
- Clicking PM Compliance, Washing Compliance, or Open Site Issues opens the matching page in Views when All plants is selected. When one plant is selected, it opens that plant's matching page. The selected date range is carried to the destination.
- The operational trend is a grouped bar chart for the selected plant or plants. Plant, Project, and District filters narrow the trend.
- Washing compliance is the percentage of configured cycles due in each bucket that were confirmed complete on or before their configured due date. Plants without a washing setup are omitted from its denominator.
- PM compliance is the percentage of non-cancelled tasks due in each bucket that were completed on or before their effective planned due date.
- Active site issues are the currently open issue records grouped by their `occurred_at` date; this series is not a historical snapshot of issue status.
- The Module Cleaning portfolio board in Views defaults to the current month and has a month picker for any past month. A plant's Module Cleaning calendar also has previous/next navigation and Week/Month views.
- Health pages in both Plants and Views provide an occurrence-date filter styled like Overview: it defaults to the current month, offers quick periods, a month picker for past months, and a toggle for a custom From–To range. Date bounds are sent to the role-scoped issue API, so paging and older months use matching records rather than only filtering the newest page. Clear filters removes the date filter.
- Clicking an issue row opens that plant's Health page; Module Cleaning cards open that plant's cleaning calendar. A saved PM or cleaning record links from its detail dialog to the plant's matching module page.
- In the portfolio Health register and Views → Details table, O&M Head and Assignee can type text into selected column-header filters. Other roles do not see these controls.
- Compliance percentages use the left axis (0–100%); issue counts use the right axis. Buckets are daily through 31 days, weekly through 366 days, then monthly. Requests are bounded to 10 years.
