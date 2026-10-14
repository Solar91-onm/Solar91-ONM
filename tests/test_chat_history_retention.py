from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys

from playwright.sync_api import sync_playwright


def test_assistant_history_keeps_entries_older_than_two_days():
    base = Path(__file__).resolve().parents[1] / "frontend" / "static"
    stale_at = int((datetime.now(timezone.utc) - timedelta(days=3)).timestamp() * 1000)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--no-sandbox"] if sys.platform.startswith("linux") else [])
        page = browser.new_page(viewport={"width": 1280, "height": 900})
        page.goto("https://example.com/")
        page.evaluate(
            """
            () => {
              window.S = {
                _roleLabel: 'O&M Head',
                plants: [],
                issues: [],
                tasks: [],
                equipment: [],
                washing: [],
                _washCycles: { plants: [], reports: [] },
                docs: [],
                incidences: [],
                inventory: [],
                vendors: [],
                serviceRequests: [],
                ptw: [],
                rules: [],
                sla: []
              };
              document.body.innerHTML = '<div id="app"><div class="shell"><div class="content"></div></div></div>';
              localStorage.clear();
              localStorage.setItem('s91-assistant-history-v1', JSON.stringify([
                { who: 'user', text: 'Show overdue issues', when: %d },
                { who: 'bot', text: 'Three overdue issues remain', when: %d }
              ]));
            }
            """ % (stale_at, stale_at + 1000)
        )

        page.add_script_tag(path=str(base / "js" / "33-command-intelligence.js"))
        page.evaluate("window.s91AssistantOpen && window.s91AssistantOpen()")

        conversation = page.locator(".s91-assistant-conversation").inner_text()
        assert "Show overdue issues" in conversation
        assert "Three overdue issues remain" in conversation

        stored = page.evaluate("localStorage.getItem('s91-assistant-history-v1') || ''")
        assert "Show overdue issues" in stored
        assert "Three overdue issues remain" in stored

        browser.close()
