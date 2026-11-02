# Portal Overview

- The Project and Area filters are populated from plants in the authenticated Overview response. Overview access is portfolio-wide for O&M Head, Assignee, and Administration; Site Engineers remain restricted to assigned plants.
- The Period filter is not used. Summary date ranges and trend ranges are separate.
- The operational trend is a grouped bar chart for the selected plant or plants. Plant, Project, and Area filters narrow the trend.
- Washing compliance is the percentage of configured cycles due in each bucket that were confirmed complete on or before their configured due date. Plants without a washing setup are omitted from its denominator.
- PM compliance is the percentage of non-cancelled tasks due in each bucket that were completed on or before their effective planned due date.
- Active site issues are the currently open issue records grouped by their `occurred_at` date; this series is not a historical snapshot of issue status.
- Compliance percentages use the left axis (0–100%); issue counts use the right axis. Buckets are daily through 31 days, weekly through 366 days, then monthly. Requests are bounded to 10 years.
