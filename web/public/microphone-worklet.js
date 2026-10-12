class MicrophoneProcessor extends AudioWorkletProcessor {
  constructor() { super(); this.buffer = new Int16Array(1600); this.offset = 0; }
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    for (const value of channel) {
      this.buffer[this.offset++] = Math.round(Math.max(-1, Math.min(1, value)) * (value < 0 ? 32768 : 32767));
      if (this.offset === this.buffer.length) {
        this.port.postMessage(this.buffer.buffer, [this.buffer.buffer]);
        this.buffer = new Int16Array(1600); this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor('microphone-processor', MicrophoneProcessor);
