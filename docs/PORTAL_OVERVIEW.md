# Portal Overview

- Plant, Project, and District choices show all values available to the signed-in user and do not narrow one another. Overview access is portfolio-wide for O&M Head, Assignee, and Administration; Site Engineers remain restricted to assigned plants.
- The default Overview range is This month. Summary tiles and trends use the selected date range.
- Clicking PM Compliance, Washing Compliance, or Open Site Issues opens the matching page in Views when All plants is selected. When one plant is selected, it opens that plant's matching page. The selected date range is carried to the destination.
- The operational trend is a grouped bar chart for the selected plant or plants. Plant, Project, and District filters narrow the trend.
- Washing compliance is the percentage of configured cycles due in each bucket that were confirmed complete on or before their configured due date. Plants without a washing setup are omitted from its denominator.
- PM compliance is the percentage of non-cancelled tasks due in each bucket that were completed on or before their effective planned due date.
- Active site issues are the currently open issue records grouped by their `occurred_at` date; this series is not a historical snapshot of issue status.
- Health pages in both Plants and Views provide an occurrence-date filter styled like Overview: it defaults to This month, offers quick periods, and has a toggle for a custom From–To range. It applies only to the visible issue register, and Clear filters removes it.
- Compliance percentages use the left axis (0–100%); issue counts use the right axis. Buckets are daily through 31 days, weekly through 366 days, then monthly. Requests are bounded to 10 years.
