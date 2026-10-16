import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]


def send(page, payload):
    return page.evaluate(
        "payload => chrome.runtime.sendMessage(payload)",
        payload,
    )


def main() -> None:
    with sync_playwright() as playwright:
        context = playwright.chromium.launch_persistent_context(
            tempfile.mkdtemp(prefix="vibe-iter-extension-"),
            headless=False,
            args=[
                "--use-fake-device-for-media-stream",
                "--use-fake-ui-for-media-stream",
                f"--disable-extensions-except={ROOT / 'dist'}",
                f"--load-extension={ROOT / 'dist'}",
            ],
        )
        worker = context.service_workers[0] if context.service_workers else context.wait_for_event('serviceworker')
        extension_id = worker.url.split("/")[2]
        game = context.new_page()
        game.goto("http://127.0.0.1:4173/fixture.html")
        game.wait_for_load_state("networkidle")
        sidepanel = context.new_page()
        sidepanel.goto(f"chrome-extension://{extension_id}/sidepanel.html")
        sidepanel.wait_for_load_state("networkidle")
        assert sidepanel.get_by_role("heading", name="Vibe Iter").is_visible()
        panel_behavior = sidepanel.evaluate(
            "async () => { "
            "await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }); "
            "return await chrome.sidePanel.getPanelBehavior(); }"
        )
        assert panel_behavior["openPanelOnActionClick"] is True

        game.bring_to_front()
        started = send(sidepanel, {"type": "START_RECORDING", "projectName": "fixture-game"})
        assert started["ok"] is True
        game.get_by_role("button", name="Launch ferry").click()
        game.mouse.move(220, 180)
        saved = send(sidepanel, {"type": "ADD_NOTE", "text": "Launch ferry feedback"})
        assert saved["ok"] is True
        saved = send(sidepanel, {"type": "GET_SESSION"})
        assert len(saved["session"]["notes"]) == 1
        screenshot = saved["session"]["notes"][0]["screenshot"]
        assert screenshot and screenshot.startswith("data:image/jpeg")
        assert any(event["type"] == "click" for event in saved["session"]["events"])
        stopped = send(sidepanel, {"type": "STOP_RECORDING"})
        assert stopped["ok"] is True
        stale = send(sidepanel, {"type": "TRANSCRIPT_SEGMENT", "sessionId": "old-session", "segment": {"id": "late", "at": 1, "text": "wrong session", "final": True}})
        assert stale["ok"] is False
        context.close()


if __name__ == "__main__":
    main()
