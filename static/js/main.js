import { Avatar } from "/static/js/avatar.js";

const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const captionEl = $("caption");
const transcriptEl = $("transcript");
const textInput = $("text-input");
const sendBtn = $("send-btn");
const form = $("prompt-form");

let avatar = null;
const history = []; // [{role: 'user'|'model', text: string}]
let captionTimer = null;

function setStatus(text, kind = "") {
  statusEl.textContent = text;
  statusEl.className = "status" + (kind ? ` ${kind}` : "");
}

function showCaption(text) {
  if (!text) {
    captionEl.classList.remove("show");
    return;
  }
  captionEl.textContent = text;
  captionEl.classList.add("show");
  if (captionTimer) clearTimeout(captionTimer);
  captionTimer = setTimeout(() => captionEl.classList.remove("show"), 6000);
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
  const canvas = document.getElementById("avatar-canvas");
  avatar = new Avatar(canvas);
  await avatar.loadModel(cfg.modelUrl);
  if (!cfg.configured) {
    setStatus("GEMINI_API_KEY missing on server", "error");
    return;
  }
  // Warm up SpeechSynthesis voices on browsers that load them async.
  if ("speechSynthesis" in window) {
    speechSynthesis.getVoices();
    speechSynthesis.onvoiceschanged = () => speechSynthesis.getVoices();
  }
  setStatus("Ready", "live");
}

function pickVoice() {
  if (!("speechSynthesis" in window)) return null;
  const voices = speechSynthesis.getVoices();
  if (!voices.length) return null;
  // Prefer en-US natural-sounding voices; otherwise the default.
  const preferred = [
    /Google US English/i,
    /Samantha/i, /Karen/i, /Moira/i, /Tessa/i,
    /Microsoft Aria/i, /Microsoft Jenny/i,
    /en-US/i, /en-GB/i,
  ];
  for (const re of preferred) {
    const v = voices.find((vv) => re.test(vv.name) || re.test(vv.lang));
    if (v) return v;
  }
  return voices[0];
}

function speak(text) {
  if (!("speechSynthesis" in window)) {
    avatar.setSpeaking(true);
    setTimeout(() => avatar.setSpeaking(false), Math.min(8000, text.length * 60));
    return;
  }
  speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  const v = pickVoice();
  if (v) utter.voice = v;
  utter.rate = 1.0;
  utter.pitch = 1.05;
  utter.onstart = () => {
    avatar.setSpeaking(true);
    setStatus("Speaking", "live");
  };
  utter.onend = () => {
    avatar.setSpeaking(false);
    setStatus("Ready", "live");
  };
  utter.onerror = () => {
    avatar.setSpeaking(false);
    setStatus("Speech error", "error");
  };
  speechSynthesis.speak(utter);
}

async function send(text) {
  appendTranscript("user", text);
  history.push({ role: "user", text });
  setStatus("Thinking…", "live");
  sendBtn.disabled = true;
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, history: history.slice(0, -1) }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "request failed");
    const reply = (data.text || "").trim();
    if (!reply) throw new Error("empty reply");
    history.push({ role: "model", text: reply });
    appendTranscript("bot", reply);
    showCaption(reply);
    speak(reply);
  } catch (err) {
    setStatus(err.message || "Error", "error");
  } finally {
    sendBtn.disabled = false;
    textInput.focus();
  }
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = textInput.value.trim();
  if (!text) return;
  textInput.value = "";
  send(text);
});

bootstrap();
