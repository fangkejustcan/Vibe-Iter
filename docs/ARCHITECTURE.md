# Architecture — v0.3

```text
Side panel: start / stop, status, optional text marker, history, audio player, ZIP
    │ runtime messages (no microphone ownership)
Service worker: session boundaries, tracked tab, serialized durable event writes
    ├── content script → semantic events + selectors + coordinates
    ├── context + screenshots (~5s / important interactions, visible game tab only)
    └── Chrome offscreen document (USER_MEDIA)
           ├── MediaRecorder Opus/WebM, including silence
           ├── every ~1 second → IndexedDB audio chunks
           └── after stop → whole recording → 127.0.0.1:4318
                            ├── original audio saved before inference
                            └── offline Whisper → timestamped segments
IndexedDB: sessions metadata, all events, frames, audio chunks
chrome.storage.local: current session ID only (legacy session migrated once)
```

The offscreen document survives side-panel closure and service-worker suspension. Audio does not depend on transcription availability. Stop waits for the last MediaRecorder data event and pending IndexedDB transactions before reporting success. Events are acknowledged only after their individual database transaction commits. No event or transcript retention slice is applied.

Runtime mutations are serialized in the worker. On worker restart, the current session is hydrated and the offscreen recorder is queried. If the recorder is gone, the session is marked interrupted, and committed chunks are recovered. A browser crash may lose the last uncommitted ~1s audio chunk. A new session never deletes older records. Recording follows only the original tab; content injection is idempotent and resumes on reload. Password input values and key contents are redacted.

Audio chunk progress wakes the worker and drives periodic context/screenshots, so sidebar UI timers are not needed. Screenshot capture checks the game is the active tab of its window; inactive pages get context without a misleading screenshot. Pointer motion and scroll are sampled at ~100ms; keyboard down/up, button down/up, click, wheel and form actions are retained as discrete events. This is not a full visual or game-state replay. Cross-origin iframe internals and canvas game objects are not instrumented.

The loopback service streams uploads to a temporary file, commits the original WebM, then runs asynchronous Whisper jobs under a model lock. VAD splits speech at pauses and caps each interval at 25s; each interval is recognized independently, restoring its offset in the original audio. This preserves repeated remarks separated by long silences, which whole-file inference can otherwise collapse. Status and timestamped segments are persisted. Whole-session uploads are capped at 2 GB; larger browser recordings remain exportable. An interrupted job can be retried from browser audio. Legacy /transcribe WAV endpoint remains for the microphone diagnostic page. The server accepts only loopback hosts and extension/loopback origins and uses cached models without downloads.

Each transcript segment automatically becomes feedback with a nearest context frame, nearest preceding interaction target, and operations from 8s before through 3s after the segment. This is a timestamp heuristic; raw audio, complete events, and frames remain available for review. Optional manual markers do not determine whether speech is retained.

ZIP includes continuous audio, all events/transcripts/feedback, Markdown, and screenshot files. JSON and Markdown do not truncate events. The UI polls small active-session summaries and reads archives directly from IndexedDB rather than repeatedly broadcasting full history. Start/stop/marker responses carry summaries, avoiding Chrome's 64 MB runtime-message ceiling on long sessions. Events have durable sequence numbers, and content scripts retry unacknowledged IDs with worker-side deduplication. Audio object URLs are UI-only; releasing them never stops recording.
