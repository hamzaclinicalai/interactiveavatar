import { Avatar } from "/static/js/avatar.js";
import { MicStreamer, PlaybackQueue } from "/static/js/audio.js";

const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const captionEl = $("caption");
const transcriptEl = $("transcript");
const micBtn = $("mic-btn");
const sendBtn = $("send-btn");
const textInput = $("text-input");
const form = $("prompt-form");

let ws = null;
let avatar = null;
let playback = null;
let mic = null;
let recording = false;
let captionTimer = null;
let assistantBuffer = "";

function setStatus(text, kind = "") {
  statusEl.textContent = text;
  statusEl.className = "status" + (kind ? ` ${kind}` : "");
}

function setCaption(text) {
  if (!text) {
    captionEl.classList.remove("show");
    return;
  }
  captionEl.textContent = text;
  captionEl.classList.add("show");
  if (captionTimer) clearTimeout(captionTimer);
  captionTimer = setTimeout(() => captionEl.classList.remove("show"), 4500);
}

function appendTranscript(role, text) {
  if (!text) return;
  const div = document.createElement("div");
  div.className = role === "user" ? "you" : "bot";
  div.textContent = (role === "user" ? "You: " : "Avatar: ") + text;
  transcriptEl.replaceChildren(div);
}

async function bootstrap() {
  const cfg = await fetch("/api/config").then((r) => r.json()).catch(() => ({}));
  if (!cfg.configured) {
    setStatus("GEMINI_API_KEY missing on server", "error");
  }
  const canvas = document.getElementById("avatar-canvas");
  avatar = new Avatar(canvas);
  playback = new PlaybackQueue({ sampleRate: 24000 });
  avatar.setLevelSource(() => playback.getLevel());
  await avatar.loadModel(cfg.modelUrl);
  connect();
}

function connect() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/ws`);
  ws.binaryType = "arraybuffer";

  ws.onopen = () => setStatus("Connecting to Gemini…");
  ws.onclose = () => {
    setStatus("Disconnected — retrying…");
    setTimeout(connect, 1500);
  };
  ws.onerror = () => setStatus("Connection error", "error");

  ws.onmessage = async (e) => {
    if (e.data instanceof ArrayBuffer) {
      await playback.resume();
      playback.enqueuePCM16(e.data);
      return;
    }
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === "ready") {
      setStatus("Ready", "live");
    } else if (msg.type === "error") {
      setStatus(msg.message || "Error", "error");
    } else if (msg.type === "user_transcript") {
      appendTranscript("user", msg.text);
    } else if (msg.type === "assistant_transcript") {
      assistantBuffer += msg.text;
      setCaption(assistantBuffer);
      appendTranscript("bot", assistantBuffer);
    } else if (msg.type === "interrupted") {
      playback.flush();
      assistantBuffer = "";
    } else if (msg.type === "turn_complete") {
      assistantBuffer = "";
    }
  };
}

function send(obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(obj));
}

function sendBinary(buf) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(buf);
}

async function startMic() {
  if (recording) return;
  await playback.resume();
  mic = new MicStreamer({
    onChunk: (buf) => sendBinary(buf),
    targetRate: 16000,
  });
  try {
    await mic.start();
  } catch (err) {
    setStatus("Mic permission denied", "error");
    mic = null;
    return;
  }
  recording = true;
  micBtn.classList.add("recording");
  micBtn.querySelector(".mic-label").textContent = "Listening…";
  setStatus("Listening", "live");
}

async function stopMic() {
  if (!recording) return;
  recording = false;
  micBtn.classList.remove("recording");
  micBtn.querySelector(".mic-label").textContent = "Talk";
  if (mic) await mic.stop();
  mic = null;
  send({ type: "audio_end" });
  setStatus("Thinking…", "live");
}

micBtn.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  startMic();
});
const stopHandlers = ["pointerup", "pointerleave", "pointercancel"];
for (const ev of stopHandlers) micBtn.addEventListener(ev, () => stopMic());

// Allow click-to-toggle as well (helps on desktops where pointer events
// are flaky).
micBtn.addEventListener("dblclick", () => {
  if (recording) stopMic(); else startMic();
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = textInput.value.trim();
  if (!text) return;
  await playback.resume();
  send({ type: "text", text });
  appendTranscript("user", text);
  textInput.value = "";
  setStatus("Thinking…", "live");
});

bootstrap();
