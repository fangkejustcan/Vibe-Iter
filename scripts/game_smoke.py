"""Exercise visible game behavior against a running Vite server."""
import argparse
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
SHOTS = ROOT / "shots"


def settled(page):
    expect(page.locator("#boat")).to_have_attribute("data-sailing", "false", timeout=5000)


def boat_position(page):
    return page.locator("#boat").evaluate(
        "el => ({x: parseFloat(el.style.left), y: parseFloat(el.style.top)})"
    )


def no_overflow(page):
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), "horizontal overflow"
    assert page.evaluate("document.documentElement.scrollHeight <= innerHeight"), "vertical overflow"


def dock_matches_route(page, island):
    # The boat and the route must end at the same painted dock, even after resizing.
    error = page.evaluate("""key => {
      const path = document.querySelector(`#routes path[data-from="${key}"]`);
      const point = path.getPointAtLength(0);
      const board = document.getElementById('game-board').getBoundingClientRect();
      const boat = document.getElementById('boat').getBoundingClientRect();
      return Math.hypot(boat.x + boat.width / 2 - board.x - point.x,
                        boat.y + boat.height / 2 - board.y - point.y);
    }""", island)
    assert error < 2, f"boat / route dock misalignment: {error}px"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:4317")
    args = parser.parse_args()
    SHOTS.mkdir(exist_ok=True)
    errors = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("console", lambda message: errors.append(message.text) if message.type == "error" else None)
        page.goto(f"{args.base_url.rstrip('/')}/game.html")
        page.wait_for_load_state("networkidle")
        expect(page.get_by_role("heading", name="潮汐邮局", exact=True)).to_be_visible()
        no_overflow(page)
        page.screenshot(path=str(SHOTS / "tidal-post-desktop.png"), animations="disabled")

        lighthouse = page.get_by_role("button", name="前往灯塔岛")
        chime = page.get_by_role("button", name="前往风铃岛")
        moon = page.get_by_role("button", name="前往月湾岛")
        first = page.get_by_role("button", name="阅读一盏留给归人的灯")
        second = page.get_by_role("button", name="阅读风里的新歌")
        third = page.get_by_role("button", name="阅读今晚一起看潮汐")

        # Discovery without selecting mail still produces an actual voyage.
        before = boat_position(page)
        lighthouse.hover()
        expect(page.locator("#tip-lighthouse")).to_be_visible()
        lighthouse.click()
        expect(page.locator("#boat")).to_have_attribute("data-sailing", "true")
        settled(page)
        assert boat_position(page) != before
        expect(page.locator("#progress-text")).to_have_text("0 / 3")
        expect(page.locator("#brief")).to_contain_text("抵达灯塔岛")
        dock_matches_route(page, "lighthouse")

        # Read clues, try a wrong island, then deliver the same letter successfully.
        first.click()
        expect(page.locator("#letter-copy")).to_contain_text("热汤")
        expect(page.locator("#letter-copy")).not_to_contain_text("灯塔岛")
        page.screenshot(path=str(SHOTS / "tidal-post-letter.png"), animations="disabled")
        chime.click()
        settled(page)
        expect(page.locator("#progress-text")).to_have_text("0 / 3")
        expect(first).to_have_attribute("aria-pressed", "true")
        expect(page.locator("#brief")).to_contain_text("还没找到收件人")
        lighthouse.click()
        settled(page)
        expect(page.locator("#progress-text")).to_have_text("1 / 3")
        expect(page.locator("#letter-meta")).to_have_text("灯塔岛 · 已送达")
        expect(page.locator("#letter-copy")).to_contain_text("空椅子")

        second.drag_to(chime)
        settled(page)
        expect(page.locator("#progress-text")).to_have_text("2 / 3")
        expect(page.locator("#letter-copy")).to_contain_text("三短一长")

        # Ocean clicks and arrow keys move the ship rather than merely updating text.
        before = boat_position(page)
        board = page.locator("#map").bounding_box()
        page.locator("#map").click(position={"x": board["width"] * .66, "y": board["height"] * .59})
        settled(page)
        after = boat_position(page)
        assert abs(after["x"] - 66) < .1 and abs(after["y"] - 59) < .1, after
        assert after != before
        page.keyboard.press("ArrowRight")
        settled(page)
        assert boat_position(page)["x"] > after["x"] + 3

        page.get_by_role("button", name="玩法帮助", exact=True).click()
        expect(page.locator("#help-panel")).to_be_visible()
        page.get_by_role("button", name="知道了").click()
        page.get_by_role("button", name="打开设置").click()
        page.locator("#sound-toggle").check()
        expect(page.locator("#brief")).to_have_text("投递提示音已打开。")
        page.locator("#route-toggle").uncheck()
        expect(page.locator("#routes")).to_be_hidden()
        page.get_by_role("button", name="打开设置").click()
        third.click()
        moon.click()
        settled(page)
        expect(page.locator("#modal")).to_be_visible()
        expect(page.locator("#progress-text")).to_have_text("3 / 3")
        page.screenshot(path=str(SHOTS / "tidal-post-complete.png"), animations="disabled")
        page.get_by_role("button", name="继续航行").click()
        expect(page.locator("#modal")).to_be_hidden()
        third.click()  # A delivered letter can be reread without being delivered twice.
        moon.click()
        settled(page)
        expect(page.locator("#progress-text")).to_have_text("3 / 3")
        expect(page.locator("#modal")).to_be_hidden()

        def reset():
            page.get_by_role("button", name="打开设置").click()
            page.get_by_role("button", name="重新整理邮包").click()
            expect(page.locator("#progress-text")).to_have_text("0 / 3")

        # Interruptions must never deliver an obsolete selection later.
        reset()
        first.click()
        lighthouse.click()
        second.click()
        settled(page)
        expect(page.locator("#progress-text")).to_have_text("0 / 3")
        expect(second).to_have_attribute("aria-pressed", "true")
        first.click()
        lighthouse.click()
        reset()
        page.wait_for_timeout(1900)  # Longer than the old voyage: no delayed delivery.
        expect(page.locator("#progress-text")).to_have_text("0 / 3")
        assert boat_position(page) == {"x": 57, "y": 48}

        # Check the actual recorded viewport and a touch / high-DPI narrow viewport.
        for label, viewport, dpr, touch in [
            ("recorded", {"width": 1054, "height": 757}, 1, False),
            ("mobile", {"width": 390, "height": 844}, 2, True),
        ]:
            context = browser.new_context(viewport=viewport, device_scale_factor=dpr, has_touch=touch)
            small = context.new_page()
            small.on("pageerror", lambda error: errors.append(str(error)))
            small.goto(f"{args.base_url.rstrip('/')}/game.html")
            small.wait_for_load_state("networkidle")
            no_overflow(small)
            small.screenshot(path=str(SHOTS / f"tidal-post-{label}.png"), animations="disabled")
            small.get_by_role("button", name="阅读一盏留给归人的灯").click()
            no_overflow(small)
            small.screenshot(path=str(SHOTS / f"tidal-post-{label}-letter.png"), animations="disabled")
            small.get_by_role("button", name="前往灯塔岛").click()
            settled(small)
            expect(small.locator("#progress-text")).to_have_text("1 / 3")
            dock_matches_route(small, "lighthouse")
            # All islands and mail remain reachable after the longer letter is shown.
            small.get_by_role("button", name="阅读风里的新歌").click()
            small.get_by_role("button", name="前往风铃岛").click()
            settled(small)
            expect(small.locator("#progress-text")).to_have_text("2 / 3")
            small.get_by_role("button", name="阅读今晚一起看潮汐").click()
            small.get_by_role("button", name="前往月湾岛").click()
            settled(small)
            expect(small.locator("#modal")).to_be_visible()
            no_overflow(small)
            context.close()

        # Resizing during travel keeps the route and the destination together.
        first.click()
        lighthouse.click()
        page.set_viewport_size({"width": 1054, "height": 757})
        settled(page)
        expect(page.locator("#progress-text")).to_have_text("1 / 3")
        dock_matches_route(page, "lighthouse")
        assert not errors, errors
        browser.close()
    print("PASS: voyages, clues, retries, drag, keyboard, settings, completion, interruptions and responsive docks")


if __name__ == "__main__":
    main()
