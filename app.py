"""Flask + Gemini Live API bridge for the interactive avatar.

The browser opens a WebSocket to /ws. It streams 16 kHz mono PCM16 mic
audio as binary frames, and JSON control messages as text frames. The
server forwards audio/text to Gemini Live and pipes the model's PCM24k
audio output (binary) and transcripts (JSON) back to the browser.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os

from dotenv import load_dotenv
from flask import Flask, jsonify, render_template
from flask_sock import Sock
from simple_websocket import ConnectionClosed

from google import genai
from google.genai import types

load_dotenv()

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("avatar")

API_KEY = os.environ.get("GEMINI_API_KEY", "").strip()
MODEL = os.environ.get("GEMINI_LIVE_MODEL", "gemini-2.0-flash-live-001").strip()
VOICE = os.environ.get("GEMINI_VOICE", "Aoede").strip()
DEFAULT_SYSTEM = (
    "You are a warm, expressive animated character with a Pixar-like "
    "personality. Speak naturally, with humor and curiosity. Keep replies "
    "short and conversational."
)
SYSTEM_INSTRUCTION = os.environ.get("AVATAR_SYSTEM_INSTRUCTION", DEFAULT_SYSTEM)
AVATAR_MODEL_URL = os.environ.get("AVATAR_MODEL_URL", "/static/models/avatar.glb")

app = Flask(__name__, static_folder="static", template_folder="templates")
app.config["SOCK_SERVER_OPTIONS"] = {"ping_interval": 25}
sock = Sock(app)


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/config")
def get_config():
    return jsonify({
        "model": MODEL,
        "voice": VOICE,
        "modelUrl": AVATAR_MODEL_URL,
        "configured": bool(API_KEY),
    })


@sock.route("/ws")
def ws_route(ws):
    if not API_KEY:
        try:
            ws.send(json.dumps({"type": "error", "message": "GEMINI_API_KEY is not set on the server."}))
        except Exception:
            pass
        return
    try:
        asyncio.run(_bridge(ws))
    except ConnectionClosed:
        log.info("ws closed")
    except Exception as e:
        log.exception("ws bridge error: %s", e)
        try:
            ws.send(json.dumps({"type": "error", "message": str(e)}))
        except Exception:
            pass


async def _bridge(ws):
    client = genai.Client(api_key=API_KEY, http_options={"api_version": "v1beta"})

    config = types.LiveConnectConfig(
        response_modalities=["AUDIO"],
        speech_config=types.SpeechConfig(
            voice_config=types.VoiceConfig(
                prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=VOICE)
            )
        ),
        system_instruction=types.Content(
            role="user",
            parts=[types.Part(text=SYSTEM_INSTRUCTION)],
        ),
        input_audio_transcription=types.AudioTranscriptionConfig(),
        output_audio_transcription=types.AudioTranscriptionConfig(),
    )

    loop = asyncio.get_running_loop()

    async def ws_recv():
        return await loop.run_in_executor(None, ws.receive)

    async def ws_send(payload):
        await loop.run_in_executor(None, ws.send, payload)

    async with client.aio.live.connect(model=MODEL, config=config) as session:
        await ws_send(json.dumps({"type": "ready", "model": MODEL, "voice": VOICE}))

        async def from_client():
            while True:
                msg = await ws_recv()
                if msg is None:
                    return
                if isinstance(msg, (bytes, bytearray)):
                    await session.send_realtime_input(
                        audio=types.Blob(data=bytes(msg), mime_type="audio/pcm;rate=16000")
                    )
                    continue
                try:
                    data = json.loads(msg)
                except Exception:
                    continue
                kind = data.get("type")
                if kind == "text":
                    text = (data.get("text") or "").strip()
                    if not text:
                        continue
                    await session.send_client_content(
                        turns=[types.Content(role="user", parts=[types.Part(text=text)])],
                        turn_complete=True,
                    )
                elif kind == "audio_end":
                    try:
                        await session.send_realtime_input(audio_stream_end=True)
                    except TypeError:
                        # Older SDKs may not support audio_stream_end kwarg.
                        pass

        async def from_gemini():
            async for response in session.receive():
                data = getattr(response, "data", None)
                if data:
                    await ws_send(data)
                sc = getattr(response, "server_content", None)
                if not sc:
                    continue
                input_tx = getattr(sc, "input_transcription", None)
                if input_tx and getattr(input_tx, "text", None):
                    await ws_send(json.dumps({"type": "user_transcript", "text": input_tx.text}))
                output_tx = getattr(sc, "output_transcription", None)
                if output_tx and getattr(output_tx, "text", None):
                    await ws_send(json.dumps({"type": "assistant_transcript", "text": output_tx.text}))
                if getattr(sc, "interrupted", False):
                    await ws_send(json.dumps({"type": "interrupted"}))
                if getattr(sc, "turn_complete", False):
                    await ws_send(json.dumps({"type": "turn_complete"}))

        await asyncio.gather(from_client(), from_gemini())


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)), debug=True)
