import WebSocket from 'ws';
import { z } from 'zod';
import { setTimeout as delay } from 'node:timers/promises';
import {
  OUTCOMES,
  type Call,
  type Order,
  type Settings,
} from '@orderline/contracts';
import { config } from '../../../config/index.js';
import type { Store } from '../../../platform/persistence/store.js';
import type { VoiceAgent, VoiceOutput } from '../voice.js';
import { agentPrompt, openingGreeting } from '../prompt.js';
import { quotesCustomer, recordOutcome } from '../outcome.js';

const replySchema = z
  .object({
    reply: z.string().trim().min(1).max(700),
    outcome: z.enum(OUTCOMES).nullable(),
    evidence: z.string().max(1000).nullable(),
  })
  .strict();
const completionSchema = z.object({
  choices: z
    .array(z.object({ message: z.object({ content: z.string().max(10000) }) }))
    .min(1),
});
const synthesisSchema = z.object({
  audios: z.array(z.string().max(4000000)).min(1).max(4),
});
const speechEvent = z.object({
  event: z.string(),
  text: z.string().max(4000).optional(),
  utterance_idx: z.number().int().nonnegative().optional(),
  is_fatal: z.boolean().optional(),
});
type Message = { role: 'system' | 'assistant' | 'user'; content: string };

// Sarvam's WAV output is decoded here; both adapters expose mono PCM16 at 24 kHz.
export function wavPcm24k(data: string): Buffer {
  if (data.length > 4000000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data))
    throw new Error('Invalid synthesized audio.');
  const wav = Buffer.from(data, 'base64');
  if (
    wav.toString('ascii', 0, 4) !== 'RIFF' ||
    wav.toString('ascii', 8, 12) !== 'WAVE'
  )
    throw new Error('Expected WAV audio.');
  let format = false;
  let audio: Buffer | undefined;
  for (let pos = 12; pos + 8 <= wav.length;) {
    const name = wav.toString('ascii', pos, pos + 4);
    const size = wav.readUInt32LE(pos + 4);
    const begin = pos + 8;
    if (begin + size > wav.length) throw new Error('Truncated WAV audio.');
    if (name === 'fmt ') {
      if (
        size < 16 ||
        wav.readUInt16LE(begin) !== 1 ||
        wav.readUInt16LE(begin + 2) !== 1 ||
        wav.readUInt32LE(begin + 4) !== 24000 ||
        wav.readUInt16LE(begin + 14) !== 16
      )
        throw new Error('Unsupported WAV format.');
      format = true;
    }
    if (name === 'data') audio = wav.subarray(begin, begin + size);
    pos = begin + size + (size % 2);
  }
  if (!format || !audio?.length || audio.length % 2)
    throw new Error('Missing PCM audio.');
  return audio;
}

export class SarvamAgent implements VoiceAgent {
  private socket: WebSocket | null = null;
  private closed = false;
  private ready = false;
  private startupTimer?: ReturnType<typeof setTimeout>;
  private resolveStartup?: (value: boolean) => void;
  private controller?: AbortController;
  private settings!: Settings;
  private messages: Message[] = [];
  private customerText = '';
  private lastUtterance = -1;
  constructor(
    private call: Call,
    private store: Store,
    private output: VoiceOutput,
    private dependencies: {
      request: typeof fetch;
      socket: (url: URL, options: WebSocket.ClientOptions) => WebSocket;
    } = {
      request: fetch,
      socket: (url, options) => new WebSocket(url, options),
    },
  ) {}

  async connect(order: Order, settings: Settings): Promise<boolean> {
    this.settings = settings;
    this.messages = [
      {
        role: 'system',
        content: `${agentPrompt(order, settings)}
For this adapter, replace tool calls with a JSON object: {"reply":"short spoken response", "outcome":null, "evidence":null}.
Only propose an outcome when supported by an exact quote from customer speech. Use null until a decision is explicit. On a decision, reply with its acknowledgement and goodbye. Never claim an external order was updated.`,
      },
    ];
    const url = new URL('wss://api.sarvam.ai/speech-to-text-realtime/ws');
    url.search = new URLSearchParams({
      model: settings.sarvamSttModel,
      language_code:
        settings.language === 'Hindi'
          ? 'hi-IN'
          : settings.language === 'English'
            ? 'en-IN'
            : 'auto',
      encoding: 'linear16',
      sample_rate: '16000',
      endpointing: 'vad',
      mode: 'transcribe',
      silence_duration_ms: '500',
    }).toString();
    return new Promise<boolean>((resolve) => {
      this.resolveStartup = resolve;
      this.startupTimer = setTimeout(
        () =>
          this.fail(
            'Sarvam speech connection timed out. Check model access and quota.',
          ),
        12000,
      );
      try {
        this.socket = this.dependencies.socket(url, {
          headers: { 'Api-Subscription-Key': config.SARVAM_API_KEY },
          handshakeTimeout: 12000,
          maxPayload: 100000,
        });
        this.socket.on('message', (raw) => {
          if (this.closed) return;
          try {
            const event = speechEvent.parse(JSON.parse(raw.toString()));
            if (event.event === 'session.begin' && !this.ready) {
              this.ready = true;
              clearTimeout(this.startupTimer);
              resolve(true);
              void this.respond('', false);
            } else if (event.event === 'vad.speech_start') this.interrupt();
            else if (event.event === 'transcript.final' && event.text?.trim()) {
              if (event.utterance_idx !== undefined) {
                if (event.utterance_idx <= this.lastUtterance) return;
                this.lastUtterance = event.utterance_idx;
              }
              this.text(event.text);
            } else if (event.event === 'error' || event.event === 'session.end')
              this.fail(
                'Sarvam speech session ended. Check API access, model availability, and quota.',
              );
          } catch {
            this.fail('Sarvam returned an invalid speech response.');
          }
        });
        this.socket.on('error', () =>
          this.fail(
            'Sarvam speech connection failed. Check SARVAM_API_KEY and model access.',
          ),
        );
        this.socket.on('close', () => {
          if (!this.closed) this.fail('Sarvam speech connection closed.');
        });
      } catch {
        this.fail('Could not start Sarvam speech recognition.');
      }
    });
  }
  audio(data: string) {
    if (
      this.closed ||
      !this.ready ||
      this.socket?.readyState !== WebSocket.OPEN
    )
      return;
    if (this.socket.bufferedAmount > 512000) {
      this.fail('Sarvam audio connection is too slow.');
      return;
    }
    this.socket.send(JSON.stringify({ event: 'audio_input', audio: data }));
  }
  text(text: string) {
    if (this.closed || !this.ready) return;
    this.interrupt();
    const utterance = text.trim().slice(0, 4000);
    if (!utterance) return;
    this.customerText = `${this.customerText}\n${utterance}`.slice(-16000);
    this.store.appendTranscript(this.call.id, 'customer', utterance);
    this.output.transcript('customer', utterance);
    void this.respond(utterance, true);
  }
  private interrupt() {
    this.controller?.abort();
    this.output.interrupted();
  }
  private async post(
    path: string,
    body: object,
    signal: AbortSignal,
  ): Promise<unknown> {
    const response = await this.dependencies.request(
      `https://api.sarvam.ai${path}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'api-subscription-key': config.SARVAM_API_KEY,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
      },
    );
    if (!response.ok || !response.body)
      throw new Error('Sarvam request failed.');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > 4000000) throw new Error('Sarvam response too large.');
        chunks.push(value);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
  private async respond(text: string, customer: boolean) {
    const controller = new AbortController();
    this.controller?.abort();
    this.controller = controller;
    const current = () => !this.closed && !controller.signal.aborted;
    if (customer) this.messages.push({ role: 'user', content: text });
    this.messages = [this.messages[0]!, ...this.messages.slice(1).slice(-30)];
    try {
      let decision: z.infer<typeof replySchema>;
      if (!customer) {
        // Synthesize the scripted introduction directly so the provider announcement cannot be omitted by the conversation model.
        decision = {
          reply: openingGreeting(this.settings),
          outcome: null,
          evidence: null,
        };
      } else {
        const result = completionSchema.parse(
          await this.post(
            '/v1/chat/completions',
            {
              model: this.settings.sarvamModel,
              messages: this.messages,
              max_tokens: 600,
              temperature: 0.2,
              response_format: { type: 'json_object' },
            },
            controller.signal,
          ),
        );
        if (!current()) return;
        decision = replySchema.parse(
          JSON.parse(result.choices[0]!.message.content),
        );
      }
      let spoken = decision.reply;
      // Validate before synthesis, but persist only after synthesis succeeds.
      const valid =
        decision.outcome !== null &&
        quotesCustomer(this.customerText, decision.evidence ?? '');
      if (decision.outcome && !valid)
        spoken =
          this.settings.language === 'English'
            ? 'Would you like to confirm this test order, decline it, or request follow up?'
            : 'क्या आप इस टेस्ट ऑर्डर की पुष्टि करना चाहते हैं, मना करना चाहते हैं, या बाद में बात करना चाहते हैं?';
      let audio = synthesisSchema
        .parse(
          await this.post(
            '/text-to-speech',
            {
              text: spoken,
              model: this.settings.sarvamTtsModel,
              language_code:
                this.settings.language === 'English' ? 'en-IN' : 'hi-IN',
              speech_sample_rate: 24000,
              output_audio_codec: 'wav',
            },
            controller.signal,
          ),
        )
        .audios.map(wavPcm24k);
      if (!current()) return;
      if (valid) {
        const recorded = recordOutcome(
          this.call,
          this.store,
          this.customerText,
          { outcome: decision.outcome, evidence: decision.evidence },
          this.output,
        );
        if (recorded.error) {
          // Never play an acknowledgement for a rejected or contradictory decision.
          spoken =
            this.settings.language === 'English'
              ? 'I could not record that decision. Please clarify your request.'
              : 'मैं यह निर्णय दर्ज नहीं कर पाया। कृपया अपनी बात स्पष्ट करें।';
          audio = synthesisSchema
            .parse(
              await this.post(
                '/text-to-speech',
                {
                  text: spoken,
                  model: this.settings.sarvamTtsModel,
                  language_code:
                    this.settings.language === 'English' ? 'en-IN' : 'hi-IN',
                  speech_sample_rate: 24000,
                  output_audio_codec: 'wav',
                },
                controller.signal,
              ),
            )
            .audios.map(wavPcm24k);
          if (!current()) return;
        }
      }
      this.messages.push({ role: 'assistant', content: spoken });
      this.store.appendTranscript(this.call.id, 'agent', spoken);
      this.output.transcript('agent', spoken);
      // Pace 20 ms frames so interruption can discard unplayed speech.
      for (const pcm of audio) {
        for (let start = 0; start < pcm.length; start += 960) {
          if (!current()) return;
          this.output.audio(
            pcm.subarray(start, start + 960).toString('base64'),
          );
          await delay(20, undefined, { signal: controller.signal });
        }
      }
      if (current())
        this.output.turnComplete(
          Boolean(this.store.call(this.call.id)?.outcome),
        );
    } catch {
      if (current())
        this.fail(
          'Sarvam response failed. Check API access, selected models, and quota.',
        );
    }
  }
  private fail(message: string) {
    if (!this.closed) {
      this.close();
      this.output.failure(message);
    }
  }
  close() {
    this.closed = true;
    this.ready = false;
    clearTimeout(this.startupTimer);
    this.resolveStartup?.(false);
    this.controller?.abort();
    this.socket?.terminate();
    this.socket = null;
  }
}
