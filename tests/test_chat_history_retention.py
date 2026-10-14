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
              window.AUTH_IDENTITY = {userId: 'history-user-a', role: 'O&M Head'};
              document.body.innerHTML = '<div id="app"><div class="shell"><div class="content"></div></div></div>';
              localStorage.clear();
              localStorage.setItem('s91-assistant-history-v1', JSON.stringify([
                { who: 'user', text: 'Unscoped old conversation', when: %d }
              ]));
              localStorage.setItem('s91-assistant-history-v1:history-user-a', JSON.stringify([
                { who: 'user', text: 'Show overdue issues', when: %d },
                { who: 'bot', text: 'Three overdue issues remain', when: %d }
              ]));
              localStorage.setItem('s91-assistant-history-v1:history-user-b', JSON.stringify([
                { who: 'user', text: 'Private question for user B', when: %d },
                { who: 'bot', text: 'Private answer for user B', when: %d }
              ]));
            }
            """ % (stale_at, stale_at, stale_at + 1000, stale_at, stale_at + 1000)
        )

        page.add_style_tag(path=str(base / "css" / "33-command-intelligence.css"))
        page.add_script_tag(path=str(base / "js" / "33-command-intelligence.js"))
        page.evaluate("window.s91AssistantOpen && window.s91AssistantOpen()")

        conversation = page.locator(".s91-assistant-conversation").inner_text()
        assert "Show overdue issues" in conversation
        assert "Three overdue issues remain" in conversation

        stored = page.evaluate("localStorage.getItem('s91-assistant-history-v1:history-user-a') || ''")
        assert "Show overdue issues" in stored
        assert "Three overdue issues remain" in stored
        assert "Private question for user B" not in conversation
        assert "Unscoped old conversation" not in conversation
        assert page.evaluate("localStorage.getItem('s91-assistant-history-v1')") is None

        page.evaluate(
            """
            () => {
              window.AUTH_IDENTITY.userId = 'history-user-b';
              window.s91AssistantOpen();
            }
            """
        )
        other_conversation = page.locator(".s91-assistant-conversation").inner_text()
        assert "Private question for user B" in other_conversation
        assert "Show overdue issues" not in other_conversation

        page.evaluate(
            """
            () => {
              window.AUTH_IDENTITY.userId = 'history-user-a';
              window.s91AssistantOpen();
            }
            """
        )
        assert "Show overdue issues" in page.locator(".s91-assistant-conversation").inner_text()

        launch = page.locator(".s91-assistant-launch")
        bounds = launch.bounding_box()
        page.mouse.move(bounds["x"] + bounds["width"] / 2, bounds["y"] + bounds["height"] / 2)
        page.mouse.down()
        page.mouse.move(20, 20, steps=5)
        page.mouse.up()
        position = page.evaluate("JSON.parse(localStorage.getItem('s91-assistant-position-v1:history-user-a'))")
        assert position and position["left"] < bounds["x"]
        assert position["top"] < bounds["y"]
        panel = page.locator(".s91-assistant-panel").bounding_box()
        assert panel["x"] >= 0
        assert panel["y"] >= 0
        assert panel["x"] + panel["width"] <= 1280
        assert panel["y"] + panel["height"] <= 900

        bounds = launch.bounding_box()
        page.mouse.move(bounds["x"] + bounds["width"] / 2, bounds["y"] + bounds["height"] / 2)
        page.mouse.down()
        page.mouse.move(1260, 880, steps=5)
        page.mouse.up()
        position = page.evaluate("JSON.parse(localStorage.getItem('s91-assistant-position-v1:history-user-a'))")
        panel = page.locator(".s91-assistant-panel").bounding_box()
        assert panel["x"] >= 0
        assert panel["y"] >= 0
        assert panel["x"] + panel["width"] <= 1280
        assert panel["y"] + panel["height"] <= 900

        page.evaluate(
            """
            () => {
              window.AUTH_IDENTITY.userId = 'history-user-b';
              window.s91AssistantOpen();
            }
            """
        )
        assert page.evaluate("localStorage.getItem('s91-assistant-position-v1:history-user-b')") is None
        assert page.evaluate("document.getElementById('s91-assistant-root').style.left") == ""

        page.evaluate(
            """
            () => {
              window.AUTH_IDENTITY.userId = 'history-user-a';
              window.s91AssistantOpen();
            }
            """
        )
        restored = page.locator(".s91-assistant-launch").bounding_box()
        assert abs(restored["x"] - position["left"]) < 1
        assert abs(restored["y"] - position["top"]) < 1

        browser.close()
