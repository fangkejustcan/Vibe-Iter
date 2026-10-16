"""Verify missing transcription service and browser-interruption recovery."""
from pathlib import Path
import tempfile
import time

from playwright.sync_api import sync_playwright
from session_recording_smoke import SidePanel, fixture

ROOT = Path(__file__).resolve().parents[1]


def send(page, payload):
    result = page.evaluate('(payload) => chrome.runtime.sendMessage(payload)', payload)
    assert result['ok'], result
    return result


def state(page):
    return send(page, {'type': 'GET_SESSION'})['session']


def wait(page, predicate, seconds=90):
    until = time.monotonic() + seconds
    while time.monotonic() < until:
        result = state(page)
        if predicate(result): return result
        page.wait_for_timeout(400)
    raise AssertionError(state(page).get('transcription'))


def main():
    source = fixture(16)
    profile = Path(tempfile.mkdtemp(prefix='vibe-recovery-'))
    with sync_playwright() as p:
        def launch():
            context = p.chromium.launch_persistent_context(str(profile), headless=False, args=[
                f'--load-extension={ROOT / "dist"}', f'--disable-extensions-except={ROOT / "dist"}',
                '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
                f'--use-file-for-fake-audio-capture={source}', '--remote-debugging-port=0',
            ])
            worker = context.service_workers[0] if context.service_workers else context.wait_for_event('serviceworker')
            origin = f'chrome-extension://{worker.url.split("/")[2]}'
            page = context.new_page(); page.goto(f'{origin}/sidepanel.html')
            return context, page, origin

        context, control, origin = launch()
        try:
            game = context.new_page(); game.goto('http://127.0.0.1:4173/game.html')
            game.bring_to_front()
            send(control, {'type': 'START_RECORDING', 'projectName': 'offline-service'})
            recorder = SidePanel(profile, origin, 'offscreen.html')
            recorder.command('Network.enable', {})
            recorder.command('Network.setBlockedURLs', {'urls': ['http://127.0.0.1:4318/*']})
            game.keyboard.press('w'); game.mouse.click(500, 390)
            game.wait_for_timeout(8500)
            send(control, {'type': 'STOP_RECORDING'})
            saved = wait(control, lambda item: item['transcription']['status'] == 'error')
            assert saved['audio']['status'] == 'saved' and saved['audio']['chunks'] >= 8, saved['audio']
            first_id = saved['id']
            recorder.command('Network.setBlockedURLs', {'urls': []})
            send(control, {'type': 'TRANSCRIBE_SESSION', 'sessionId': first_id})
            completed = wait(control, lambda item: item['transcription']['status'] == 'complete')
            assert completed['transcript'] and completed['notes'], completed['transcription']
            print('PASS: service unavailable retains audio; later real transcription succeeds', flush=True)

            # Leave an archive's retry in flight, then start another session. Browser
            # exit must also make the archive's interrupted transcription retryable.
            recorder.command('Fetch.enable', {'patterns': [{'urlPattern': 'http://127.0.0.1:4318/*', 'requestStage': 'Request'}]})
            send(control, {'type': 'TRANSCRIBE_SESSION', 'sessionId': first_id})
            assert state(control)['transcription']['status'] == 'running'

            # Close the entire browser during another recording, then restore the same profile.
            game.bring_to_front()
            send(control, {'type': 'START_RECORDING', 'projectName': 'browser-interruption'})
            game.keyboard.press('a')
            game.wait_for_timeout(4500)
            before = state(control)
            assert before['audio']['chunks'] >= 3
            recorder.ws.close()
            context.close()
            context, control, origin = launch()
            recovered = state(control)
            assert recovered['id'] == before['id']
            assert recovered['status'] == 'finished' and recovered['audio']['status'] == 'interrupted', recovered['audio']
            assert recovered['audio']['bytes'] >= before['audio']['bytes']
            assert recovered['events'] and recovered['audio']['chunks'] >= before['audio']['chunks']
            history = send(control, {'type': 'LIST_SESSIONS'})['sessions']
            assert len(history) == 2
            original = send(control, {'type': 'GET_SESSION', 'sessionId': first_id})['session']
            assert original['transcript'] and original['audio']['status'] == 'saved'
            assert original['transcription']['status'] == 'error', original['transcription']
            print('PASS: browser exit recovers committed audio and events; prior history intact', flush=True)
            print('PASS: interrupted transcription in archived session is retryable after restart', flush=True)
        finally:
            context.close()


if __name__ == '__main__':
    main()
