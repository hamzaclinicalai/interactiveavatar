# Interactive Avatar (Gemini Live + Flask)

A real-time talking avatar. Hold the mic, speak, and a Pixar-style 3D
character speaks back — powered by **Google Gemini Live API** for native
speech-to-speech and **Three.js** for the rendered character with audio-
driven lip-sync.

- Backend: Python / Flask / `flask-sock` (WebSocket bridge to Gemini)
- Frontend: vanilla JS + Three.js (ES modules via importmap, no build step)
- Voice: Gemini Live native audio (16 kHz in / 24 kHz out)
- Deploy target: Heroku (Procfile included)

## Architecture

```
browser  ──mic PCM16 16kHz──▶  Flask /ws  ──▶  Gemini Live (audio in)
browser  ◀──audio PCM 24kHz──  Flask /ws  ◀──  Gemini Live (audio out)
                              + JSON transcripts / control events
```

The browser captures mic audio in an `AudioWorklet`, downsamples it to 16
kHz Int16, and streams it as binary frames. The server forwards it to the
Gemini Live session; the model's audio replies are streamed back as
binary frames and queued for playback. An `AnalyserNode` taps the
playback graph and feeds amplitude into the Three.js scene to drive
mouth-open / jaw-open morph targets.

## Run locally

1. Python 3.11+. Create a venv and install deps:
   ```bash
   python -m venv .venv && source .venv/bin/activate
   pip install -r requirements.txt
   ```
2. Copy `.env.example` to `.env` and set your key:
   ```bash
   cp .env.example .env
   # edit GEMINI_API_KEY=...
   ```
3. (Optional) Drop a rigged GLB at `static/models/avatar.glb`. A
   Ready Player Me half-body or full-body export works great — we look
   for ARKit-style morph targets (`jawOpen`, `mouthOpen`, `viseme_*`,
   `eyeBlinkLeft/Right`). Without a model the app uses a stylized
   procedural fallback so it still works end-to-end.
4. Start the dev server:
   ```bash
   python app.py
   ```
   Open <http://localhost:5000>, allow mic access, hold **Talk** and
   speak — or type a prompt and press enter.

## Deploy to Heroku

```bash
heroku create
heroku config:set GEMINI_API_KEY=your_key_here
# Optional overrides:
# heroku config:set GEMINI_LIVE_MODEL=gemini-2.0-flash-live-001
# heroku config:set GEMINI_VOICE=Aoede
# heroku config:set AVATAR_SYSTEM_INSTRUCTION="You are ..."
# heroku config:set AVATAR_MODEL_URL=https://example.com/your-avatar.glb

git push heroku HEAD:main
heroku open
```

The `Procfile` runs `gunicorn` with the `gthread` worker, which is
required for the long-lived WebSocket bridge. WebSocket support on
Heroku works out of the box on the standard router.

> **Note**: Gemini Live API access depends on your Google AI / Vertex
> account. If your key isn't enabled for the Live API, switch
> `GEMINI_LIVE_MODEL` to one that is, or wire up Vertex auth instead.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `GEMINI_API_KEY` | — | **Required.** Google AI API key with Live access. |
| `GEMINI_LIVE_MODEL` | `gemini-2.0-flash-live-001` | Live-capable model id. |
| `GEMINI_VOICE` | `Aoede` | Prebuilt Live voice (`Aoede`, `Charon`, `Fenrir`, `Kore`, `Puck`, ...). |
| `AVATAR_SYSTEM_INSTRUCTION` | friendly default | Personality / system prompt. |
| `AVATAR_MODEL_URL` | `/static/models/avatar.glb` | URL or path to GLB. |

## File map

```
app.py                   Flask app + WebSocket bridge to Gemini Live
templates/index.html     Page shell, importmap for Three.js
static/js/main.js        Client orchestration: ws, mic, text, playback
static/js/audio.js       MicStreamer (worklet → 16 kHz PCM16) + PlaybackQueue
static/js/pcm-worklet.js AudioWorklet that captures float frames
static/js/avatar.js      Three.js scene, GLB loader, lip-sync + blinks
static/css/style.css     HUD styling
static/models/           Drop your avatar.glb here
Procfile                 Heroku gunicorn config (gthread, long-lived ws)
runtime.txt              Python 3.11.9 for Heroku
requirements.txt         Python deps
```

## Customizing the character

The avatar renderer auto-detects morph targets by name. If your model
uses non-standard names, edit the regex lists at the top of
`static/js/avatar.js` (`MOUTH_PATTERNS`, `SMILE_PATTERNS`,
`BLINK_PATTERNS`). For a more cinematic feel, swap in PBR materials,
add post-processing (bloom, depth-of-field) via Three.js
`EffectComposer`, or replace the procedural backdrop with an HDRI.
