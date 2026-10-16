"""End-to-end: synthesized Chinese WAV -> Chrome mic -> offline Whisper -> storage.

Requires the local Whisper service and game server. No recognition API mocks.
"""
from pathlib import Path
import tempfile
import wave

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]


def create_chinese_audio():
    import win32com.client
    import av
    import numpy as np
    folder = ROOT / '.local'
    folder.mkdir(exist_ok=True)
    source = folder / 'chinese-feedback.wav'
    voice = win32com.client.Dispatch('SAPI.SpVoice')
    for token in voice.GetVoices():
        if 'Huihui' in token.GetDescription():
            voice.Voice = token
            break
    output = win32com.client.Dispatch('SAPI.SpFileStream')
    output.Open(str(source), 3, False)
    voice.AudioOutputStream = output
    voice.Speak('这个岛屿的标签太小了，请把文字放大一点。')
    output.Close()
    # Chromium's fake capture expects 16-bit PCM; add a short quiet lead-in.
    with av.open(str(source)) as container:
        resampler = av.AudioResampler(format='s16', layout='mono', rate=16000)
        frames = []
        for frame in container.decode(audio=0):
            frames.extend(resampler.resample(frame))
        frames.extend(resampler.resample(None))
        samples = np.concatenate([frame.to_ndarray().ravel() for frame in frames])
    destination = folder / 'chinese-microphone.wav'
    with wave.open(str(destination), 'wb') as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(16000)
        wav.writeframes(bytes(16000) + samples.tobytes())
    return destination


def main():
    # The v0.3 recording path owns audio in an offscreen document.
    from session_recording_smoke import main as session_test
    session_test()


if __name__ == '__main__':
    main()
