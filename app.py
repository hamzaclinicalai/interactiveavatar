"""Flask backend for the interactive avatar.

Text in, text out. The browser speaks the reply with the Web Speech API
SpeechSynthesis, so all this server has to do is run user prompts
through Gemini.
"""

from __future__ import annotations

import logging
import os

from dotenv import load_dotenv
from flask import Flask, jsonify, render_template, request

from google import genai
from google.genai import types

load_dotenv()

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("avatar")

API_KEY = os.environ.get("GEMINI_API_KEY", "").strip()
TEXT_MODEL = os.environ.get("GEMINI_TEXT_MODEL", "gemini-2.5-flash").strip()
DEFAULT_SYSTEM = (
    "You are a warm, expressive animated character. Speak naturally, "
    "with humor and curiosity. Keep replies short and conversational — "
    "two or three sentences at most."
)
SYSTEM_INSTRUCTION = os.environ.get("AVATAR_SYSTEM_INSTRUCTION", DEFAULT_SYSTEM)
AVATAR_MODEL_URL = os.environ.get("AVATAR_MODEL_URL", "/static/models/avatar.glb")

app = Flask(__name__, static_folder="static", template_folder="templates")
_client = genai.Client(api_key=API_KEY) if API_KEY else None


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/config")
def get_config():
    return jsonify({
        "model": TEXT_MODEL,
        "modelUrl": AVATAR_MODEL_URL,
        "configured": bool(API_KEY),
    })


@app.route("/api/chat", methods=["POST"])
def chat():
    if not _client:
        return jsonify({"error": "GEMINI_API_KEY is not set on the server."}), 500
    data = request.get_json(silent=True) or {}
    text = (data.get("text") or "").strip()
    history = data.get("history") or []
    if not text:
        return jsonify({"error": "empty prompt"}), 400

    contents = []
    for turn in history[-12:]:
        role = turn.get("role")
        content = (turn.get("text") or "").strip()
        if role in ("user", "model") and content:
            contents.append(types.Content(role=role, parts=[types.Part(text=content)]))
    contents.append(types.Content(role="user", parts=[types.Part(text=text)]))

    try:
        response = _client.models.generate_content(
            model=TEXT_MODEL,
            contents=contents,
            config=types.GenerateContentConfig(
                system_instruction=SYSTEM_INSTRUCTION,
                temperature=0.9,
            ),
        )
    except Exception as e:
        log.exception("Gemini error: %s", e)
        return jsonify({"error": str(e)}), 502

    reply = (response.text or "").strip()
    return jsonify({"text": reply})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)), debug=True)
