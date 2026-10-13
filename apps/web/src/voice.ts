export interface VoiceEvents {
  status(status: 'connecting' | 'listening' | 'speaking' | 'ended'): void;
  transcript(role: 'customer' | 'agent', text: string): void;
  outcome(outcome: string): void;
  error(message: string): void;
}
export class BrowserVoice {
  private socket?: WebSocket;
  private stream?: MediaStream;
  private input?: AudioContext;
  private output?: AudioContext;
  private capture?: AudioWorkletNode;
  private sources = new Set<AudioBufferSourceNode>();
  private nextPlayTime = 0;
  private ended = false;
  private closingTimer?: number;
  constructor(private events: VoiceEvents) {}
  async prepare() {
    this.events.status('connecting');
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      if (this.ended) {
        this.stream.getTracks().forEach((track) => track.stop());
        throw new Error('Practice was cancelled.');
      }
      this.input = new AudioContext({ sampleRate: 16000 });
      this.output = new AudioContext({ sampleRate: 24000 });
      await Promise.all([
        this.input.resume(),
        this.output.resume(),
        this.input.audioWorklet.addModule('/microphone-worklet.js'),
      ]);
      if (this.ended) {
        await this.input.close();
        await this.output.close();
        throw new Error('Practice was cancelled.');
      }
      if (this.input.sampleRate !== 16000)
        throw new Error(
          'This browser does not support 16 kHz microphone capture. Try a current Chrome browser.',
        );
    } catch (error) {
      this.stop();
      throw new Error(
        error instanceof Error && error.message.includes('16 kHz')
          ? error.message
          : 'Microphone access is required for practice. Allow access and try again.',
      );
    }
  }
  connect(token: string) {
    if (this.ended || !this.input || !this.output || !this.stream) return;
    const url = new URL('/ws/browser', location.href);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('token', token);
    this.socket = new WebSocket(url);
    this.socket.onmessage = (message) => {
      try {
        const data = JSON.parse(message.data);
        if (data.event === 'ready') this.startCapture();
        else if (data.event === 'audio') this.play(data.data);
        else if (data.event === 'interrupted') {
          this.clearPlayback();
          clearTimeout(this.closingTimer);
          this.events.status('listening');
        } else if (data.event === 'transcript')
          this.events.transcript(data.role, data.text);
        else if (data.event === 'outcome')
          this.events.outcome(data.call.outcome);
        else if (data.event === 'error') {
          this.events.error(data.message);
          this.stop();
        } else if (data.event === 'turn_complete') {
          const delay =
            Math.max(0, this.nextPlayTime - this.output!.currentTime) * 1000 +
            250;
          this.closingTimer = window.setTimeout(() => {
            if (data.hasOutcome) this.stop();
            else this.events.status('listening');
          }, delay);
        }
      } catch {
        this.events.error('Could not process the voice response.');
        this.stop();
      }
    };
    this.socket.onerror = () => {
      if (!this.ended)
        this.events.error(
          'Practice connection failed. Check the server and Gemini configuration.',
        );
      this.stop();
    };
    this.socket.onclose = () => this.stop();
  }
  private startCapture() {
    if (this.ended || !this.input || !this.stream) return;
    const source = this.input.createMediaStreamSource(this.stream);
    this.capture = new AudioWorkletNode(this.input, 'microphone-processor');
    this.capture.port.onmessage = (event) => {
      if (this.socket?.readyState !== WebSocket.OPEN) return;
      if (this.socket.bufferedAmount > 128000) {
        this.events.error('Connection is too slow for live audio.');
        this.stop();
        return;
      }
      const bytes = new Uint8Array(event.data);
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      this.socket.send(JSON.stringify({ event: 'audio', data: btoa(binary) }));
    };
    // The processor produces silence; connecting it keeps capture running without microphone playback.
    const muted = this.input.createGain();
    muted.gain.value = 0;
    source.connect(this.capture);
    this.capture.connect(muted);
    muted.connect(this.input.destination);
    this.events.status('listening');
  }
  private play(data: string) {
    if (!this.output || this.ended) return;
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    if (bytes.length % 2) throw new Error('Invalid output audio.');
    const buffer = this.output.createBuffer(1, bytes.length / 2, 24000);
    const channel = buffer.getChannelData(0);
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < channel.length; i++)
      channel[i] = view.getInt16(i * 2, true) / 32768;
    const node = this.output.createBufferSource();
    node.buffer = buffer;
    node.connect(this.output.destination);
    this.nextPlayTime = Math.max(
      this.output.currentTime + 0.04,
      this.nextPlayTime,
    );
    node.start(this.nextPlayTime);
    this.nextPlayTime += buffer.duration;
    this.sources.add(node);
    node.onended = () => this.sources.delete(node);
    this.events.status('speaking');
  }
  private clearPlayback() {
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {
        /* already ended */
      }
    }
    this.sources.clear();
    this.nextPlayTime = 0;
  }
  stop() {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.closingTimer);
    this.clearPlayback();
    if (this.socket?.readyState === WebSocket.OPEN)
      this.socket.send(JSON.stringify({ event: 'stop' }));
    this.socket?.close();
    this.capture?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    if (this.input) void this.input.close();
    if (this.output) void this.output.close();
    this.events.status('ended');
  }
}
