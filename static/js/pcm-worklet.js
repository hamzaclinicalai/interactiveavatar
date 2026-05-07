// AudioWorklet that captures mono float audio and posts it to the main
// thread in 20 ms-ish chunks. Resampling and Int16 conversion are done on
// the main thread so the worklet stays cheap.
class PCMCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = [];
    this._needed = Math.floor(sampleRate * 0.02); // 20 ms
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const ch = input[0];
    if (!ch) return true;
    // Copy because the underlying buffer is reused.
    this._buf.push(new Float32Array(ch));
    let total = this._buf.reduce((n, a) => n + a.length, 0);
    while (total >= this._needed) {
      const out = new Float32Array(this._needed);
      let off = 0;
      while (off < this._needed) {
        const head = this._buf[0];
        const take = Math.min(this._needed - off, head.length);
        out.set(head.subarray(0, take), off);
        off += take;
        if (take === head.length) {
          this._buf.shift();
        } else {
          this._buf[0] = head.subarray(take);
        }
      }
      total -= this._needed;
      this.port.postMessage({ samples: out, sampleRate }, [out.buffer]);
    }
    return true;
  }
}

registerProcessor("pcm-capture", PCMCapture);
