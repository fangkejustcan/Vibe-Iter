"""Load the shipped ZIP, record and export with transcription unavailable.

Serve public/ on 127.0.0.1:4173 before running. Uses a disposable profile and
Chromium's synthetic microphone; does not read any real recordings.
"""
import io
import json
from pathlib import Path
import tempfile
import zipfile

import av
from playwright.sync_api import expect, sync_playwright
from session_recording_smoke import SidePanel

ROOT = Path(__file__).resolve().parents[1]


def main():
    with tempfile.TemporaryDirectory(prefix='vibe-release-') as folder:
        work = Path(folder)
        extension = work / 'extension'
        with zipfile.ZipFile(ROOT / 'release/vibe-iter-chrome.zip') as archive:
            archive.extractall(extension)
        profile = work / 'profile'
        with sync_playwright() as p:
            context = p.chromium.launch_persistent_context(str(profile), channel='chromium',
                headless=True, accept_downloads=True, viewport={'width': 340, 'height': 860}, args=[
                    f'--load-extension={extension}', f'--disable-extensions-except={extension}',
                    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
                    '--remote-debugging-port=0', '--disable-background-timer-throttling',
                ])
            try:
                worker = context.service_workers[0] if context.service_workers else context.wait_for_event('serviceworker')
                origin = f'chrome-extension://{worker.url.split("/")[2]}'
                panel = context.new_page()
                errors = []
                panel.on('pageerror', lambda error: errors.append(str(error)))
                panel.goto(f'{origin}/sidepanel.html')
                expect(panel.get_by_text('v0.3.2 全程记录版')).to_be_visible()
                expect(panel.locator('#project-name')).to_have_value('my-playtest')
                game = context.new_page()
                game.goto('http://127.0.0.1:4173/fixture.html')
                game.wait_for_load_state('networkidle')
                game.bring_to_front()
                panel.evaluate("() => document.querySelector('.button-primary').click()")
                expect(panel.get_by_role('button', name='结束测试')).to_be_visible(timeout=20_000)
                expect(panel.get_by_test_id('audio-status')).to_contain_text('录音已验证')
                recorder = SidePanel(profile, origin, 'offscreen.html')
                recorder.command('Network.enable', {})
                recorder.command('Network.setBlockedURLs', {'urls': ['http://127.0.0.1:4318/*']})
                # Close the UI: the offscreen document must keep recording.
                panel.close()
                game.locator('#launch').click()
                game.keyboard.press('ArrowRight')
                game.wait_for_timeout(6500)
                panel = context.new_page()
                panel.on('pageerror', lambda error: errors.append(str(error)))
                panel.goto(f'{origin}/sidepanel.html')
                expect(panel.get_by_role('button', name='结束测试')).to_be_visible(timeout=15_000)
                panel.evaluate("() => document.querySelector('button.stop').click()")
                expect(panel.locator('audio')).to_be_visible(timeout=20_000)
                panel.wait_for_function("""async () => {
                    const r = await chrome.runtime.sendMessage({type:'GET_SESSION',summary:true});
                    return r.session.transcription?.status === 'error';
                }""", timeout=20_000)
                assert panel.evaluate('() => document.documentElement.scrollWidth <= innerWidth')
                game.bring_to_front()
                with panel.expect_download() as pending:
                    panel.evaluate("() => [...document.querySelectorAll('button')].find(b=>b.textContent.includes('导出完整包')).click()")
                download = work / 'playtest.zip'
                pending.value.save_as(download)
                with zipfile.ZipFile(download) as archive:
                    assert {'audio.webm', 'session.json', 'report.md', 'README.txt'} <= set(archive.namelist())
                    assert any(name.startswith('screenshots/') for name in archive.namelist())
                    saved = json.loads(archive.read('session.json'))
                    assert saved['audio']['status'] == 'saved' and saved['audio']['chunks'] >= 6
                    assert any(event['type'] == 'click' for event in saved['events'])
                    assert any(event.get('key') == 'ArrowRight' for event in saved['events'])
                    with av.open(io.BytesIO(archive.read('audio.webm'))) as media:
                        seconds = sum(frame.samples / frame.sample_rate for frame in media.decode(audio=0))
                    assert seconds >= 6, seconds
                assert not errors, errors
                (ROOT / 'shots').mkdir(exist_ok=True)
                panel.screenshot(path=str(ROOT / 'shots/package-smoke.png'), full_page=True)
                recorder.ws.close()
                print(f'PASS: shipped ZIP, synthetic audio {seconds:.2f}s, closed UI, events, screenshots, export; transcription service blocked')
            finally:
                context.close()


if __name__ == '__main__':
    main()
