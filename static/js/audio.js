// Mic capture (downsampled to 16 kHz Int16) + 24 kHz PCM playback queue
// with an AnalyserNode tap so the avatar can drive lip-sync from the
// model's voice amplitude.

export class MicStreamer {
  constructor({ onChunk, targetRate = 16000 }) {
    this.onChunk = onChunk;
    this.targetRate = targetRate;
    this.ctx = null;
    this.stream = null;
    this.node = null;
    this.source = null;
    this.running = false;
  }

  async start() {
    if (this.running) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    await this.ctx.audioWorklet.addModule("/static/js/pcm-worklet.js");
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, "pcm-capture");
    this.node.port.onmessage = (e) => {
      const { samples, sampleRate } = e.data;
      const down = downsample(samples, sampleRate, this.targetRate);
      const pcm = floatToInt16(down);
      if (this.onChunk) this.onChunk(pcm.buffer);
    };
    this.source.connect(this.node);
    // Don't connect node to destination — we don't want to hear the mic.
    this.running = true;
  }

  async stop() {
    if (!this.running) return;
    this.running = false;
    try { this.source && this.source.disconnect(); } catch {}
    try { this.node && this.node.disconnect(); } catch {}
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
    }
    if (this.ctx) {
      try { await this.ctx.close(); } catch {}
    }
    this.ctx = this.stream = this.node = this.source = null;
  }
}

function downsample(buffer, fromRate, toRate) {
  if (toRate === fromRate) return buffer;
  if (toRate > fromRate) return buffer; // no upsampling needed in our case
  const ratio = fromRate / toRate;
  const newLen = Math.floor(buffer.length / ratio);
  const out = new Float32Array(newLen);
  let pos = 0;
  let i = 0;
  while (i < newLen) {
    const next = Math.floor((i + 1) * ratio);
    let sum = 0;
    let count = 0;
    for (let j = pos; j < next && j < buffer.length; j++) {
      sum += buffer[j];
      count++;
    }
    out[i] = count > 0 ? sum / count : 0;
    pos = next;
    i++;
  }
  return out;
}

function floatToInt16(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    let s = Math.max(-1, Math.min(1, float32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

export class PlaybackQueue {
  constructor({ sampleRate = 24000 } = {}) {
    this.sampleRate = sampleRate;
    this.ctx = null;
    this.gain = null;
    this.analyser = null;
    this._next = 0;
    this._levelData = null;
  }

  _ensureCtx() {
    if (this.ctx) return;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: this.sampleRate });
    this.gain = this.ctx.createGain();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.4;
    this.gain.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);
    this._levelData = new Uint8Array(this.analyser.frequencyBinCount);
    this._next = this.ctx.currentTime;
  }

  async resume() {
    this._ensureCtx();
    if (this.ctx.state === "suspended") await this.ctx.resume();
  }

  enqueuePCM16(arrayBuffer) {
    this._ensureCtx();
    const int16 = new Int16Array(arrayBuffer);
    if (int16.length === 0) return;
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 0x8000;
    const buf = this.ctx.createBuffer(1, float32.length, this.sampleRate);
    buf.copyToChannel(float32, 0);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.gain);
    const start = Math.max(this.ctx.currentTime, this._next);
    src.start(start);
    this._next = start + buf.duration;
  }

  flush() {
    if (!this.ctx) return;
    // Replace gain to immediately silence anything queued, then continue
    // with a fresh node.
    try { this.gain.disconnect(); } catch {}
    this.gain = this.ctx.createGain();
    this.gain.connect(this.analyser);
    this._next = this.ctx.currentTime;
  }

  /**
   * Returns 0..1 amplitude of currently playing audio. Use to drive lip-sync.
   */
  getLevel() {
    if (!this.analyser) return 0;
    this.analyser.getByteTimeDomainData(this._levelData);
    let peak = 0;
    for (let i = 0; i < this._levelData.length; i++) {
      const v = Math.abs(this._levelData[i] - 128);
      if (v > peak) peak = v;
    }
    return Math.min(1, peak / 90);
  }

  isSpeaking() {
    return this.getLevel() > 0.05;
  }
}
