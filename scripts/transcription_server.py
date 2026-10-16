"""Loopback-only, offline Whisper transcription for Vibe Iter."""
import argparse
import io
import json
import os
from pathlib import Path
import threading
import time
import wave

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from faster_whisper import WhisperModel
from faster_whisper.audio import decode_audio
from faster_whisper.vad import VadOptions, get_speech_timestamps
from starlette.concurrency import run_in_threadpool
import uvicorn


ROOT = Path(__file__).resolve().parents[1]
app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"chrome-extension://[a-p]{32}|http://(127\.0\.0\.1|localhost):\d+",
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)
model = None
model_name = "small"
model_error = ""
lock = threading.Lock()
clips = ROOT / ".local" / "voice-clips"
sessions = ROOT / ".local" / "sessions"
jobs = set()
jobs_lock = threading.Lock()


def session_directory(session_id: str):
    import re
    if not re.fullmatch(r"session-[a-zA-Z0-9-]{1,100}", session_id):
        raise HTTPException(400, "Invalid session ID")
    directory = sessions / session_id
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def save_job(directory, value):
    temporary = directory / "transcription.tmp"
    temporary.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
    os.replace(temporary, directory / "transcription.json")


def recognize_session(path):
    # Transcribing a silence-concatenated recording in one model window can
    # collapse repeated feedback into one segment spanning minutes. Keep each
    # speech interval independent and restore offsets in the original audio.
    sampling_rate = 16000
    samples = decode_audio(str(path), sampling_rate=sampling_rate)
    intervals = get_speech_timestamps(samples, VadOptions(
        min_silence_duration_ms=700, max_speech_duration_s=25, speech_pad_ms=300,
    ), sampling_rate=sampling_rate)
    result = []
    for interval in intervals:
        begin, end = interval['start'], interval['end']
        parts, _ = model.transcribe(
            samples[begin:end], language="zh", beam_size=1,
            vad_filter=False, condition_on_previous_text=False,
        )
        for part in parts:
            text = part.text.strip()
            if text:
                result.append({"start": begin / sampling_rate + part.start,
                    "end": min(end / sampling_rate, begin / sampling_rate + part.end), "text": text})
    return result, len(samples) / sampling_rate


@app.post("/sessions/{session_id}/audio")
async def upload_session(session_id: str, request: Request):
    directory = session_directory(session_id)
    with jobs_lock:
        if session_id in jobs:
            raise HTTPException(409, "Transcription is already running")
        # Reserve through the upload, including concurrent requests.
        jobs.add(session_id)
    temporary = directory / "audio.upload"
    size = 0
    try:
        with temporary.open("wb") as target:
            async for chunk in request.stream():
                size += len(chunk)
                if size > 2_000_000_000:
                    raise HTTPException(413, "Session audio exceeds 2 GB; export the original audio instead")
                target.write(chunk)
        if not size:
            raise HTTPException(400, "Empty recording")
        os.replace(temporary, directory / "audio.webm")
        save_job(directory, {"status": "pending"})
        return {"saved": True, "bytes": size}
    finally:
        with jobs_lock:
            jobs.discard(session_id)
        temporary.unlink(missing_ok=True)


@app.post("/sessions/{session_id}/transcribe")
def transcribe_session(session_id: str):
    directory = session_directory(session_id)
    if model is None:
        raise HTTPException(503, model_error or "Whisper is still loading")
    if not (directory / "audio.webm").exists():
        raise HTTPException(404, "Upload audio first")
    with jobs_lock:
        if session_id in jobs:
            return {"status": "running"}
        jobs.add(session_id)
    save_job(directory, {"status": "running"})

    def run():
        try:
            with lock:
                segments, duration = recognize_session(directory / "audio.webm")
            save_job(directory, {"status": "complete", "duration": duration, "segments": segments})
        except Exception as error:
            save_job(directory, {"status": "error", "error": str(error)})
        finally:
            with jobs_lock:
                jobs.discard(session_id)

    threading.Thread(target=run, daemon=True).start()
    return {"status": "running"}


@app.get("/sessions/{session_id}/transcription")
def session_transcription(session_id: str):
    directory = session_directory(session_id)
    path = directory / "transcription.json"
    if not path.exists():
        return {"status": "pending"}
    result = json.loads(path.read_text(encoding="utf-8"))
    with jobs_lock:
        if result["status"] == "running" and session_id not in jobs:
            return {"status": "error", "error": "Transcription was interrupted; retry with the saved audio."}
    return result


@app.middleware("http")
async def local_requests_only(request: Request, call_next):
    import re
    from starlette.responses import JSONResponse
    # Reject DNS-rebinding hosts and ordinary websites, even outside CORS.
    origin = request.headers.get("origin", "")
    host = request.url.hostname
    if host not in ("127.0.0.1", "localhost") or (origin and not re.fullmatch(
        r"chrome-extension://[a-p]{32}|http://(127\.0\.0\.1|localhost):\d+", origin
    )):
        return JSONResponse({"detail": "Only local extension requests are accepted."}, status_code=403)
    return await call_next(request)


@app.get("/health")
def health():
    return {"service": "vibe-iter-whisper", "ready": model is not None, "model": model_name, "error": model_error}


def recognize(data: bytes, language: str):
    with lock:
        segments, _ = model.transcribe(
            io.BytesIO(data), language=language, beam_size=1,
            vad_filter=True, condition_on_previous_text=False,
        )
        return "".join(segment.text for segment in segments).strip()


@app.post("/transcribe")
async def transcribe(request: Request, language: str = "zh", at: int = 0):
    if model is None:
        raise HTTPException(503, model_error or "Whisper is still loading")
    if language not in ("zh", "en"):
        raise HTTPException(400, "Unsupported language")
    data = bytearray()
    async for chunk in request.stream():
        data.extend(chunk)
        if len(data) > 4_000_000:
            raise HTTPException(413, "Audio clip is too large")
    try:
        with wave.open(io.BytesIO(data)) as wav:
            if wav.getnchannels() != 1 or wav.getsampwidth() != 2 or wav.getnframes() / wav.getframerate() > 30:
                raise ValueError("Expected mono 16-bit WAV, up to 30 seconds")
    except (wave.Error, EOFError, ValueError) as error:
        raise HTTPException(400, str(error)) from error
    clips.mkdir(parents=True, exist_ok=True)
    # Save first: failed recognition can be retried without losing the opinion.
    stamp = f"{time.time_ns()}"
    path = clips / f"{stamp}.wav"
    path.write_bytes(data)
    metadata = {"at": at, "language": language, "text": None}
    metadata_path = path.with_suffix(".json")
    metadata_path.write_text(json.dumps(metadata, ensure_ascii=False), encoding="utf-8")
    started = time.monotonic()
    try:
        text = await run_in_threadpool(recognize, bytes(data), language)
    except Exception as error:
        metadata["error"] = str(error)
        metadata_path.write_text(json.dumps(metadata, ensure_ascii=False), encoding="utf-8")
        raise HTTPException(500, "Transcription failed; the WAV is saved locally.") from error
    metadata["text"] = text
    metadata_path.write_text(json.dumps(metadata, ensure_ascii=False), encoding="utf-8")
    return {"text": text, "at": at, "clip": path.name, "elapsed": round(time.monotonic() - started, 2)}


def main():
    global model, model_name, model_error
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=4318)
    parser.add_argument("--model", default=os.environ.get("VIBE_WHISPER_MODEL", "small"))
    args = parser.parse_args()
    model_name = args.model

    def load():
        global model, model_error
        try:
            model = WhisperModel(model_name, device="cpu", compute_type="int8", cpu_threads=6, local_files_only=True)
            print(f"Whisper {model_name} ready (CPU int8, offline)", flush=True)
        except Exception as error:
            model_error = str(error)
            print(f"Whisper load failed: {model_error}", flush=True)

    threading.Thread(target=load, daemon=True).start()
    uvicorn.run(app, host="127.0.0.1", port=args.port)


if __name__ == "__main__":
    main()
