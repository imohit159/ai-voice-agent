/** Stateful linear PCM conversion preserves fractional position between network chunks. */
export class PcmResampler {
  private samples: number[] = [];
  private position = 0;
  constructor(private inputRate: number, private outputRate: number) {}
  reset() { this.samples = []; this.position = 0; }
  push(input: Buffer): Buffer {
    if (input.length % 2) throw new Error('PCM frames must contain whole 16-bit samples.');
    if (this.inputRate === this.outputRate) return input;
    for (let i = 0; i < input.length; i += 2) this.samples.push(input.readInt16LE(i));
    const step = this.inputRate / this.outputRate;
    const output: number[] = [];
    while (this.position + 1 < this.samples.length) {
      const index = Math.floor(this.position);
      const fraction = this.position - index;
      output.push(Math.round(this.samples[index]! * (1 - fraction) + this.samples[index + 1]! * fraction));
      this.position += step;
    }
    const consumed = Math.min(Math.floor(this.position), this.samples.length);
    this.samples = this.samples.slice(consumed);
    this.position -= consumed;
    const buffer = Buffer.allocUnsafe(output.length * 2);
    output.forEach((sample, i) => buffer.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), i * 2));
    return buffer;
  }
}

export class ExotelAudioFrames {
  private buffer = Buffer.alloc(0);
  constructor(private emit: (data: Buffer) => void) {}
  push(input: Buffer) {
    this.buffer = Buffer.concat([this.buffer, input]);
    while (this.buffer.length >= 3200) {
      this.emit(this.buffer.subarray(0, 3200));
      this.buffer = this.buffer.subarray(3200);
    }
  }
  finish() {
    if (this.buffer.length) {
      const frame = Buffer.alloc(3200);
      this.buffer.copy(frame);
      this.emit(frame);
    }
    this.reset();
  }
  reset() { this.buffer = Buffer.alloc(0); }
}
export function decodeAudio(payload: string): Buffer {
  if (!payload || payload.length > 140000 || payload.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) throw new Error('Invalid audio payload.');
  const audio = Buffer.from(payload, 'base64');
  if (audio.length > 100000 || audio.length % 2) throw new Error('Invalid PCM audio frame.');
  return audio;
}
export function exotelSampleRate(format: { encoding: string; sample_rate: string | number; bit_rate?: string | number }) {
  const rate = Number(format.sample_rate);
  const bitrate = format.bit_rate === undefined ? undefined : Number(format.bit_rate);
  // Exotel reports PCM bitrate in kbps (128 at 8 kHz); older streams report the 16-bit sample depth.
  if (![8000, 16000, 24000].includes(rate) || !['audio/x-raw', 'audio/pcm', 'raw', 'slin'].includes(format.encoding)
    || (bitrate !== undefined && bitrate !== 16 && bitrate !== rate * 16 / 1000)) throw new Error('Unsupported audio format.');
  return rate;
}

