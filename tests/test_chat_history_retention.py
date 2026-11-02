from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys

from playwright.sync_api import sync_playwright

# Removed with the frontend bundle they asserted on (the portal replaced it):
#   test_assistant_history_prunes_only_entries_older_than_ten_days_and_isolates_users
#   test_assistant_renders_layered_live_result_and_record_source
