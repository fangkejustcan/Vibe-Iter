"""Load the shipped ZIP, record and export with transcription unavailable.

Uses a routed local fixture, disposable profile and Chromium's synthetic
microphone; no server or real recordings are used.
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
        downloads = work / 'downloads'
        downloads.mkdir()
        (profile / 'Default').mkdir(parents=True)
        (profile / 'Default/Preferences').write_text(json.dumps({'download': {'default_directory': str(downloads), 'prompt_for_download': False}}), encoding='utf-8')
        with sync_playwright() as p:
            context = p.chromium.launch_persistent_context(str(profile), channel='chromium',
                headless=True, accept_downloads=True, viewport={'width': 340, 'height': 860}, args=[
                    f'--load-extension={extension}', f'--disable-extensions-except={extension}',
                    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
                    '--remote-debugging-port=0', '--disable-background-timer-throttling',
                ])
            try:
                cdp = context.new_cdp_session(context.pages[0])
                cdp.send('Browser.setDownloadBehavior', {'behavior': 'default'})
                worker = context.service_workers[0] if context.service_workers else context.wait_for_event('serviceworker')
                origin = f'chrome-extension://{worker.url.split("/")[2]}'
                panel = context.new_page()
                errors = []
                panel.on('pageerror', lambda error: errors.append(str(error)))
                panel.goto(f'{origin}/sidepanel.html')
                version = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))['version']
                expect(panel.get_by_text(f'v{version} 全程记录版')).to_be_visible()
                expect(panel.locator('#project-name')).to_have_value('my-playtest')
                panel.locator('#project-name').fill('handoff-one')
                panel.locator('.project-details summary').click()
                panel.locator('#project-path').fill(str(work / 'project-worktree'))
                game = context.new_page()
                game.route('http://127.0.0.1:4173/**', lambda route: route.fulfill(path=str(ROOT / 'public/fixture.html'), content_type='text/html'))
                game.goto('http://127.0.0.1:4173/fixture.html?project=recorded')
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
                # An unrelated foreground tab and edited form must not redirect the old recording.
                unrelated = context.new_page()
                unrelated.route('**/*', lambda route: route.fulfill(status=200, content_type='text/html', body='<h1>Other project</h1>'))
                unrelated.goto('http://localhost:9999/other-project')
                panel.locator('#project-name').fill('wrong-current-form')
                expect(panel.get_by_role('button', name='复制交接提示词')).to_be_disabled()
                panel.get_by_role('button', name='保存反馈 ZIP', exact=True).click()
                expect(panel.get_by_test_id('handoff-saved')).to_be_visible(timeout=20000)
                download = Path(panel.get_by_test_id('handoff-path').inner_text())
                assert download.is_file(), download
                assert download.parent == downloads / 'Vibe-Iter', download
                assert 'handoff-one_127-0-0-1_p4173_fixture-html_' in download.name, download.name
                assert 'project=recorded' not in download.name
                prompt = panel.locator('#handoff-prompt').input_value()
                assert 'localhost:9999' not in prompt and 'wrong-current-form' not in prompt
                assert 'http://127.0.0.1:4173/fixture.html?project=recorded' in prompt
                assert json.dumps(str(download), ensure_ascii=False) in prompt
                assert '可能粘贴错了对话框' in prompt and '一次完整迭代' in prompt
                assert panel.evaluate("async () => (await navigator.permissions.query({name:'clipboard-write'})).state") == 'granted'
                # Capture only this synthetic copy; never read the user's system clipboard.
                panel.evaluate("Object.defineProperty(navigator, 'clipboard', {configurable:true,value:{writeText:async text=>{window.__copied=text}}})")
                panel.get_by_role('button', name='复制交接提示词').click()
                expect(panel.get_by_role('button', name='已复制提示词')).to_be_visible()
                assert panel.evaluate('window.__copied') == prompt
                (ROOT / 'shots').mkdir(exist_ok=True)
                panel.screenshot(path=str(ROOT / 'shots/handoff-prompt.png'), full_page=True)
                with zipfile.ZipFile(download) as archive:
                    assert {'audio.webm', 'session.json', 'report.md', 'README.txt', 'HANDOFF.json', 'HANDOFF.md'} <= set(archive.namelist())
                    assert any(name.startswith('screenshots/') for name in archive.namelist())
                    saved = json.loads(archive.read('session.json'))
                    handoff = json.loads(archive.read('HANDOFF.json'))
                    assert handoff['sessionId'] == saved['id']
                    assert saved['projectPath'] == str(work / 'project-worktree')
                    assert handoff['projectName'] == 'handoff-one'
                    assert '一次完整迭代' in archive.read('report.md').decode('utf-8')
                    assert saved['audio']['status'] == 'saved' and saved['audio']['chunks'] >= 6
                    assert any(event['type'] == 'click' for event in saved['events'])
                    assert any(event.get('key') == 'ArrowRight' for event in saved['events'])
                    with av.open(io.BytesIO(archive.read('audio.webm'))) as media:
                        seconds = sum(frame.samples / frame.sample_rate for frame in media.decode(audio=0))
                    assert seconds >= 6, seconds
                # Durable receipt: reopening the UI recovers the exact saved path and prompt.
                first_id = saved['id']
                panel.reload()
                expect(panel.locator('#handoff-prompt')).to_have_value(prompt, timeout=15000)
                panel.get_by_role('button', name='重新保存反馈 ZIP').click()
                expect(panel.get_by_test_id('handoff-path')).not_to_have_text(str(download), timeout=15000)
                second_download = Path(panel.get_by_test_id('handoff-path').inner_text())
                assert second_download.is_file() and download.is_file()
                assert second_download != download
                panel.evaluate("() => {window.__search=chrome.downloads.search;chrome.downloads.search=async()=>[{state:'interrupted',error:'USER_CANCELED'}]}")
                expect(panel.get_by_role('button', name='复制交接提示词')).to_be_disabled(timeout=10000)
                expect(panel.locator('#handoff-prompt')).to_have_count(0)
                panel.evaluate('() => {chrome.downloads.search=window.__search}')
                expect(panel.get_by_role('button', name='复制交接提示词')).to_be_enabled(timeout=10000)
                # A second recording must have its own receipt, while history keeps the first.
                game.bring_to_front()
                panel.locator('#project-name').fill('handoff-one')
                panel.locator('.project-details summary').click()
                panel.locator('#project-path').fill(str(work / 'project-worktree-two'))
                panel.evaluate("() => document.querySelector('.button-primary').click()")
                expect(panel.get_by_role('button', name='结束测试')).to_be_visible(timeout=20000)
                expect(panel.locator('#handoff-prompt')).to_have_count(0)
                expect(panel.get_by_role('button', name='复制交接提示词')).to_be_disabled()
                game.wait_for_timeout(1500)
                panel.evaluate("() => document.querySelector('button.stop').click()")
                expect(panel.get_by_role('button', name='开始测试')).to_be_visible(timeout=20000)
                panel.get_by_role('button', name='保存反馈 ZIP', exact=True).click()
                expect(panel.get_by_test_id('handoff-saved')).to_be_visible(timeout=20000)
                assert 'project-worktree-two' in panel.locator('#handoff-prompt').input_value()
                panel.locator('#session-history').select_option(first_id)
                expect(panel.get_by_test_id('handoff-path')).to_have_text(str(second_download), timeout=15000)
                assert 'handoff-one' in panel.locator('#handoff-prompt').input_value()
                assert 'project-worktree-two' not in panel.locator('#handoff-prompt').input_value()
                # Missing and interrupted files must never leave an enabled copy button.
                panel.evaluate("async () => { const entries = await chrome.storage.local.get(null); const receipt = Object.values(entries).find(v=>v?.context?.sessionId === document.querySelector('#session-history').value); await chrome.downloads.removeFile(receipt.downloadId) }")
                expect(panel.get_by_role('button', name='复制交接提示词')).to_be_disabled(timeout=15000)
                expect(panel.locator('#handoff-prompt')).to_have_count(0)
                assert not errors, errors
                (ROOT / 'shots').mkdir(exist_ok=True)
                panel.screenshot(path=str(ROOT / 'shots/package-smoke.png'), full_page=True)
                recorder.ws.close()
                print(f'PASS: shipped ZIP, synthetic audio {seconds:.2f}s; automatic real disk save; exact path copy; switched tab; unique exports; reopen/history isolation; missing-file copy blocked; transcription service blocked')
            finally:
                context.close()


if __name__ == '__main__':
    main()
