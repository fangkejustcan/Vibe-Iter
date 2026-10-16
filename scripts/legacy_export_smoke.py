"""Reproduce new UI / old worker mismatch and verify actual ZIP downloads."""
import json
from pathlib import Path
import tempfile
import zipfile
from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]


def main():
    with sync_playwright() as p:
        context = p.chromium.launch_persistent_context(tempfile.mkdtemp(prefix='vibe-legacy-'), headless=False,
            accept_downloads=True, viewport={'width': 340, 'height': 860}, args=[
                f'--load-extension={ROOT / "dist"}', f'--disable-extensions-except={ROOT / "dist"}',
            ])
        try:
            worker = context.service_workers[0] if context.service_workers else context.wait_for_event('serviceworker')
            origin = f'chrome-extension://{worker.url.split("/")[2]}'
            panel = context.new_page()
            panel.add_init_script('''(() => {
              window.__starts=0;
              const endedAt=Date.now();
              window.__legacy={id:'session-legacy',projectName:'legacy',startedAt:endedAt-147000,endedAt,
                status:'finished',events:[{id:'event-old',at:endedAt-1000,type:'click'}],
                transcript:[],notes:[]};
              chrome.runtime.sendMessage=async(message)=>{
                if(message.type==='START_RECORDING') window.__starts++;
                return {ok:true,session:window.__legacy};
              };
            })()''')
            panel.goto(f'{origin}/sidepanel.html')
            expect(panel.get_by_role('alert')).to_contain_text('版本不一致')
            expect(panel.get_by_role('button', name='开始测试', exact=True)).to_be_disabled()
            assert panel.evaluate('() => window.__starts') == 0
            expect(panel.get_by_test_id('audio-status')).to_contain_text('没有保存整场录音')
            expect(panel.locator('audio')).to_have_count(0)
            # Record is deliberately absent from IndexedDB, reproducing the old silent return.
            with panel.expect_download() as info:
                panel.get_by_role('button', name='导出现存记录 ZIP').click()
            artifact = ROOT / '.local' / 'legacy-export.zip'
            info.value.save_as(str(artifact))
            with zipfile.ZipFile(artifact) as archive:
                assert archive.testzip() is None
                assert 'audio.webm' not in archive.namelist()
                assert 'AUDIO-MISSING.txt' in archive.namelist()
                stored = json.loads(archive.read('session.json'))
                assert stored['events'][0]['id'] == 'event-old'
            expect(panel.get_by_role('status').filter(has_text='已导出现存记录')).to_be_visible()
            # Large text export remains valid without a blob worker under MV3 CSP.
            panel.evaluate("() => {window.__legacy.transcript=[{id:'large',at:Date.now(),final:true,text:'feedback '.repeat(150000)}]}")
            with panel.expect_download() as info:
                panel.get_by_role('button', name='导出现存记录 ZIP').click()
            info.value.save_as(str(artifact))
            with zipfile.ZipFile(artifact) as archive:
                assert archive.testzip() is None
                assert len(archive.read('report.md')) > 1_000_000
            # A rejected Chrome download is visible at the top; no silent no-op.
            panel.evaluate("() => {chrome.downloads.download=async()=>{throw new Error('download rejected test')}}")
            panel.get_by_role('button', name='Markdown', exact=True).click()
            expect(panel.get_by_role('alert')).to_contain_text('download rejected test')
            assert panel.evaluate('() => document.documentElement.scrollWidth <= innerWidth')
            (ROOT / 'shots').mkdir(exist_ok=True)
            panel.screenshot(path=str(ROOT / 'shots' / 'legacy-export.png'), full_page=True)
            print('PASS: mismatched worker blocked, absent DB record exported, missing audio explicit, large valid ZIP, download errors visible')
        finally:
            context.close()


if __name__ == '__main__':
    main()
