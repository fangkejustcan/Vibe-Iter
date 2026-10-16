"""Small-width UI verification in a real extension, with a synthetic mic."""
from pathlib import Path
import tempfile
from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]


def main():
    with sync_playwright() as p:
        context = p.chromium.launch_persistent_context(tempfile.mkdtemp(prefix='vibe-ui-'), headless=False,
            viewport={'width': 340, 'height': 860}, args=[
                f'--load-extension={ROOT / "dist"}', f'--disable-extensions-except={ROOT / "dist"}',
                '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
            ])
        try:
            worker = context.service_workers[0] if context.service_workers else context.wait_for_event('serviceworker')
            origin = f'chrome-extension://{worker.url.split("/")[2]}'
            panel = context.new_page(); panel.goto(f'{origin}/sidepanel.html')
            errors = []
            panel.on('pageerror', lambda error: errors.append(str(error)))
            expect(panel.get_by_text('v0.3.2 全程记录版')).to_be_visible()
            game = context.new_page(); game.goto('http://127.0.0.1:4173/game.html')
            game.bring_to_front()
            panel.evaluate("() => document.querySelector('.button-primary').click()")
            expect(panel.get_by_role('button', name='结束测试')).to_be_visible(timeout=20_000)
            expect(panel.get_by_test_id('audio-status')).to_contain_text('录音已验证')
            saved = panel.evaluate("() => chrome.runtime.sendMessage({type:'GET_SESSION',summary:true})")['session']
            assert saved['audio']['bytes'] > 0 and saved['audio']['chunks'] >= 1
            expect(panel.get_by_role('meter', name='麦克风输入音量')).to_be_visible()
            panel.locator('textarea').fill('这个按钮反馈太弱')
            panel.get_by_role('button', name='添加文字标记').click()
            game.wait_for_timeout(2200)
            panel.evaluate("() => document.querySelector('button.stop').click()")
            expect(panel.locator('audio')).to_be_visible(timeout=20_000)
            expect(panel.get_by_text('这个按钮反馈太弱')).to_be_visible()
            assert panel.evaluate('() => document.documentElement.scrollWidth <= innerWidth')
            assert not errors, errors
            (ROOT / 'shots').mkdir(exist_ok=True)
            panel.screenshot(path=str(ROOT / 'shots' / 'ui-smoke.png'), full_page=True)
            print('PASS: narrow UI, unified start/stop, optional marker, original audio playback, no page errors')
        finally:
            context.close()


if __name__ == '__main__':
    main()
