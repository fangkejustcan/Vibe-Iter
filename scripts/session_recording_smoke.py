"""Real extension/offscreen audio regression; use --seconds 310 for hands-off test.

Uses a disposable Chromium profile and synthesized Chinese speech. No ASR mocks.
Requires game at :4173 and the local Whisper service at :4318.
"""
import argparse
import base64
import io
import json
from pathlib import Path
import tempfile
import time
from urllib.request import urlopen
import wave
import zipfile

import av
import numpy as np
from playwright.sync_api import sync_playwright
import websocket
from local_voice_smoke import create_chinese_audio

ROOT = Path(__file__).resolve().parents[1]


def read_session(page, session_id=None):
    # Large frame histories are read from IndexedDB, not sent through Chrome's
    # 64 MB runtime message ceiling. Only image-presence flags cross CDP here.
    return page.evaluate('''async (id) => {
      const current = await chrome.runtime.sendMessage({type:'GET_SESSION',summary:true});
      id ||= current.session.id;
      const db = await new Promise((resolve,reject)=>{const r=indexedDB.open('vibe-iter-recordings',1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
      const read=(store,all=false)=>new Promise((resolve,reject)=>{const s=db.transaction(store).objectStore(store);const r=all?s.index('sessionId').getAll(id):s.get(id);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
      const [metadata,events,frames]=await Promise.all([read('sessions'),read('events',true),read('frames',true)]);
      events.sort((a,b)=>a.sequence!==undefined&&b.sequence!==undefined?a.sequence-b.sequence:a.at-b.at);
      return {...metadata,events,frames:frames.map(f=>({...f,screenshot:Boolean(f.screenshot)})),notes:metadata.notes.map(n=>({...n,screenshot:Boolean(n.screenshot)}))};
    }''', session_id)


class SidePanel:
    def __init__(self, profile, origin, path='sidepanel.html'):
        port = (profile / 'DevToolsActivePort').read_text().splitlines()[0]
        until = time.monotonic() + 15
        while time.monotonic() < until:
            with urlopen(f'http://127.0.0.1:{port}/json/list') as response:
                target = next((item for item in json.load(response) if item.get('url') == f'{origin}/{path}'), None)
            if target:
                self.ws = websocket.create_connection(target['webSocketDebuggerUrl'], suppress_origin=True, timeout=120)
                self.sequence = 0
                return
            time.sleep(.2)
        raise AssertionError('Side panel did not open')

    def evaluate(self, expression):
        result = self.command('Runtime.evaluate', {
            'expression': expression, 'returnByValue': True, 'awaitPromise': True, 'userGesture': True,
        })
        assert 'exceptionDetails' not in result, result
        return result['result'].get('value')

    def command(self, method, params):
        self.sequence += 1
        self.ws.send(json.dumps({'id': self.sequence, 'method': method, 'params': params}))
        while True:
            response = json.loads(self.ws.recv())
            if response.get('id') != self.sequence:
                continue
            assert 'error' not in response, response
            return response['result']

    def wait(self, expression, seconds=30):
        until = time.monotonic() + seconds
        while time.monotonic() < until:
            result = self.evaluate(expression)
            if result:
                return result
            time.sleep(.25)
        raise AssertionError(self.evaluate('document.body.innerText'))


def fixture(seconds):
    short = create_chinese_audio()
    with wave.open(str(short), 'rb') as wav:
        speech = np.frombuffer(wav.readframes(wav.getnframes()), dtype=np.int16)
    samples = np.zeros(int((seconds + 8) * 16000), dtype=np.int16)
    offsets = [1, seconds / 2, seconds - 7] if seconds >= 30 else [1]
    for offset in offsets:
        start = int(offset * 16000)
        samples[start:start + len(speech)] = speech
    path = ROOT / '.local' / f'session-microphone-{seconds}.wav'
    with wave.open(str(path), 'wb') as wav:
        wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(16000)
        wav.writeframes(samples.tobytes())
    return path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--seconds', type=int, default=16)
    args = parser.parse_args()
    source = fixture(args.seconds)
    profile = Path(tempfile.mkdtemp(prefix='vibe-session-'))
    with sync_playwright() as p:
        context = p.chromium.launch_persistent_context(str(profile), headless=False, accept_downloads=True, args=[
            f'--disable-extensions-except={ROOT / "dist"}', f'--load-extension={ROOT / "dist"}',
            '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
            f'--use-file-for-fake-audio-capture={source}', '--remote-debugging-port=0',
            '--disable-background-timer-throttling',
        ])
        try:
            worker = context.service_workers[0] if context.service_workers else context.wait_for_event('serviceworker')
            origin = f'chrome-extension://{worker.url.split("/")[2]}'
            control = context.new_page()
            control.goto(f'{origin}/microphone.html')
            # Real authorization request; auto-allowed only by this disposable browser.
            control.locator('#allow').click()
            control.wait_for_function("() => document.querySelector('[role=status]').textContent.includes('麦克风已授权')")
            # Stop the diagnostic meter stream so it cannot mask recorder ownership.
            control.reload()
            control.evaluate("""() => {
                const b = document.createElement('button'); b.id='open-panel'; b.textContent='Open panel';
                b.onclick=()=>chrome.windows.getCurrent().then(w=>chrome.sidePanel.open({windowId:w.id}));
                document.body.append(b);
            }""")
            control.locator('#open-panel').click()
            panel = SidePanel(profile, origin)
            panel.wait("Boolean(document.querySelector('.button-primary'))")
            game = context.new_page()
            game.goto('http://127.0.0.1:4173/game.html')
            game.bring_to_front()
            panel.evaluate("document.querySelector('.button-primary').click()")
            panel.wait("Boolean(document.querySelector('.status-chip.recording'))", 20)
            start = time.monotonic()
            current = control.evaluate("() => chrome.runtime.sendMessage({type:'GET_SESSION',summary:true})")['session']
            session_id = current['id']
            print('Started actual side-panel recording', session_id, flush=True)
            # Close the actual side panel completely; no UI may own the microphone.
            control.evaluate("() => chrome.sidePanel.setOptions({enabled:false})")
            panel.ws.close()
            game.bring_to_front()
            count = 0
            middle_checked = False
            navigated = False
            restarted = False
            while time.monotonic() - start < args.seconds:
                elapsed = time.monotonic() - start
                game.mouse.move(350 + count % 200, 300 + count % 100)
                game.mouse.click(500, 390)
                game.keyboard.press('w')
                game.keyboard.press('ArrowRight')
                if not navigated and elapsed > args.seconds / 3:
                    game.reload()
                    game.wait_for_timeout(400)
                    navigated = True
                if not middle_checked and elapsed > args.seconds / 2:
                    state = control.evaluate("() => chrome.runtime.sendMessage({type:'GET_SESSION',summary:true})")['session']
                    assert state['audio']['status'] == 'recording', state
                    assert state['audio']['chunks'] > 3, state
                    print('Midpoint: panel closed, audio chunks', state['audio']['chunks'], 'events', state['eventCount'], flush=True)
                    middle_checked = True
                if args.seconds >= 60 and not restarted and elapsed > args.seconds * .6:
                    # Terminate only the disposable test extension worker, not the offscreen page.
                    cdp = context.new_cdp_session(control)
                    targets = cdp.send('Target.getTargets')['targetInfos']
                    target = next(item for item in targets if item['type'] == 'service_worker' and item['url'].startswith(origin))
                    cdp.send('Target.closeTarget', {'targetId': target['targetId']})
                    cdp.detach()
                    restarted = True
                    print('Terminated test service worker; audio must survive', flush=True)
                count += 1
                game.wait_for_timeout(700)

            # Stress the old 5000-event truncation limit through genuine DOM keyboard events.
            game.evaluate("""() => {
                for (let i=0;i<2600;i++) {
                  document.dispatchEvent(new KeyboardEvent('keydown',{key:'a',code:'KeyA',bubbles:true}));
                  document.dispatchEvent(new KeyboardEvent('keyup',{key:'a',code:'KeyA',bubbles:true}));
                }
            }""")
            game.wait_for_timeout(3000)
            control.evaluate("() => chrome.sidePanel.setOptions({enabled:true})")
            # Open side panel with a user gesture, without activating the control tab.
            control.evaluate("() => document.querySelector('#open-panel')?.click()")
            panel = SidePanel(profile, origin)
            panel.wait("Boolean(document.querySelector('button.stop'))")
            panel.evaluate("document.querySelector('button.stop').click()")
            panel.wait("!document.querySelector('.status-chip.recording') && Boolean(document.querySelector('audio'))", 60)
            stored = read_session(control)
            assert stored['audio']['status'] == 'saved', stored['audio']
            assert len(stored['events']) > 5000, len(stored['events'])
            assert [item['sequence'] for item in stored['events']] == list(range(len(stored['events'])))
            keys = {item.get('key') for item in stored['events'] if item['type'] == 'keyup'}
            assert 'w' in keys and 'ArrowRight' in keys, keys
            assert min(e['at'] for e in stored['events']) - stored['startedAt'] < 4000
            assert max(e['at'] for e in stored['events']) - stored['startedAt'] > args.seconds * 900
            assert any(frame.get('screenshot') for frame in stored['frames'])
            print('Stopped: persisted events', len(stored['events']), 'chunks', stored['audio']['chunks'], flush=True)
            # Export from actual side panel, inspect actual ZIP and decode actual Opus audio.
            download_directory = Path(tempfile.mkdtemp(prefix='downloads-', dir=ROOT / '.local'))
            cdp = context.new_cdp_session(control)
            cdp.send('Browser.setDownloadBehavior', {'behavior': 'allow', 'downloadPath': str(download_directory)})
            panel.evaluate("() => {document.querySelector('.extra-exports').open=true; Array.from(document.querySelectorAll('button')).find(b=>b.textContent.includes('另存 ZIP')).click()}")
            until = time.monotonic() + 120
            while time.monotonic() < until:
                downloads = list(download_directory.glob('*.zip'))
                if downloads: break
                game.wait_for_timeout(500)
            assert downloads, panel.evaluate('document.body.innerText')
            artifact = ROOT / '.local' / f'session-smoke-{args.seconds}.zip'
            artifact.write_bytes(downloads[0].read_bytes())
            with zipfile.ZipFile(artifact) as archive:
                assert {'audio.webm', 'session.json', 'report.md'} <= set(archive.namelist())
                audio = archive.read('audio.webm')
                exported = json.loads(archive.read('session.json'))
                assert len(exported['events']) == len(stored['events'])
                first = exported['events'][0]
                relative = (first['at'] - exported['startedAt']) / 1000
                assert f'+{relative:.1f}s **{first["type"]}**' in archive.read('report.md').decode('utf-8')
            with av.open(io.BytesIO(audio)) as media:
                decoded = list(media.decode(audio=0))
                duration = sum(frame.samples / frame.sample_rate for frame in decoded)
            wall_duration = (stored['endedAt'] - stored['startedAt']) / 1000
            assert abs(duration - wall_duration) < 2.5, (duration, wall_duration)
            assert duration >= args.seconds, (duration, args.seconds)
            print('Audio seconds', round(duration, 2), 'wall', round(wall_duration, 2), 'ZIP', artifact, flush=True)
            until = time.monotonic() + 180
            while time.monotonic() < until:
                result = read_session(control)
                if result['transcription']['status'] in ('complete', 'error'):
                    break
                game.wait_for_timeout(1000)
            assert result['transcription']['status'] == 'complete', result['transcription']
            assert result['transcript'], result['transcription']
            assert all(note['source'] == 'automatic' for note in result['notes'])
            assert any('标签' in item['text'] or '文字' in item['text'] for item in result['transcript'])
            if args.seconds >= 60:
                offsets = [(item['at'] - result['startedAt']) / 1000 for item in result['transcript']]
                assert min(offsets) < 20 and max(offsets) > args.seconds - 20, offsets
                assert any(args.seconds * .4 < offset < args.seconds * .6 for offset in offsets), offsets
            assert any(note.get('screenshot') and note.get('nearbyEvents') for note in result['notes'])
            print('Transcription:', json.dumps(result['transcript'], ensure_ascii=True), flush=True)
            # New session and sidebar reopen must retain the first session.
            game.bring_to_front()
            second = control.evaluate("() => chrome.runtime.sendMessage({type:'START_RECORDING',projectName:'history-check'})")
            assert second['ok'], second
            game.wait_for_timeout(2200)
            control.evaluate("() => chrome.runtime.sendMessage({type:'STOP_RECORDING'})")
            history = control.evaluate("() => chrome.runtime.sendMessage({type:'LIST_SESSIONS'})")['sessions']
            assert len(history) == 2 and any(item['id'] == session_id for item in history)
            old = read_session(control, session_id)
            assert len(old['events']) == len(stored['events']) and old['audio']['bytes'] > 0
            screenshot_page = context.new_page()
            screenshot_page.goto(f'{origin}/sidepanel.html')
            screenshot_page.wait_for_timeout(2000)
            (ROOT / 'shots').mkdir(exist_ok=True)
            screenshot_page.screenshot(path=str(ROOT / 'shots' / 'session-recording.png'), full_page=True)
            print('PASS: continuous audio, closed real panel, navigation, >5000 events, complete ZIP, real ASR, automatic feedback, history', flush=True)
        finally:
            context.close()


if __name__ == '__main__':
    main()
