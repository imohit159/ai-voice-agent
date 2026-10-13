import type { WebSocket } from 'ws';
import { z } from 'zod';
import { config } from '../../config/index.js';
import type { Call } from '@orderline/contracts';
import type { Store } from '../../platform/persistence/store.js';
import { createVoiceAgent } from './live.js';
import {
  PcmResampler,
  ExotelAudioFrames,
  decodeAudio,
  exotelSampleRate,
} from './audio.js';

const browserMessage = z.discriminatedUnion('event', [
  z.object({ event: z.literal('audio'), data: z.string().max(50000) }),
  z.object({
    event: z.literal('text'),
    text: z.string().trim().min(1).max(1000),
  }),
  z.object({ event: z.literal('stop') }),
]);
const exotelMessage = z.object({
  event: z.enum(['connected', 'start', 'media', 'stop', 'mark', 'dtmf']),
  stream_sid: z.string().max(128).optional(),
  start: z
    .object({
      stream_sid: z.string().min(1).max(128),
      call_sid: z.string().min(1).max(128),
      account_sid: z.string().max(128),
      media_format: z.object({
        encoding: z.string(),
        sample_rate: z.union([z.string(), z.number()]),
        bit_rate: z.union([z.string(), z.number()]).optional(),
      }),
    })
    .optional(),
  media: z.object({ payload: z.string().max(140000) }).optional(),
  stop: z.object({ reason: z.string().optional() }).optional(),
  mark: z.object({ name: z.string().max(128) }).optional(),
});

export function attachVoice(socket: WebSocket, call: Call, store: Store) {
  const isPhone = call.mode === 'phone';
  let streamSid = '';
  let started = false;
  let ready = false;
  let ended = false;
  let closingTimer: ReturnType<typeof setTimeout> | undefined;
  let inputConverter = new PcmResampler(16000, 16000);
  let outputConverter = new PcmResampler(24000, 16000);
  const safeSend = (data: object) => {
    if (socket.readyState !== 1 || ended) return;
    if (socket.bufferedAmount > 512000) {
      finish('Audio connection is too slow.', false);
      return;
    }
    socket.send(JSON.stringify(data));
  };
  const frames = new ExotelAudioFrames((data) =>
    safeSend({
      event: 'media',
      stream_sid: streamSid,
      media: { payload: data.toString('base64') },
    }),
  );
  const agent = createVoiceAgent(call, store, {
    audio: (data) => {
      if (isPhone) frames.push(outputConverter.push(decodeAudio(data)));
      else safeSend({ event: 'audio', data });
    },
    interrupted: () => {
      frames.reset();
      outputConverter.reset();
      clearTimeout(closingTimer);
      safeSend(
        isPhone
          ? { event: 'clear', stream_sid: streamSid }
          : { event: 'interrupted' },
      );
    },
    turnComplete: (hasOutcome) => {
      if (isPhone) {
        frames.finish();
        safeSend({
          event: 'mark',
          stream_sid: streamSid,
          mark: { name: hasOutcome ? 'goodbye' : 'turn' },
        });
        // Wait for Exotel's playback acknowledgement before closing the stream.
        if (hasOutcome)
          closingTimer = setTimeout(() => finish(undefined, false), 15000);
      } else {
        safeSend({ event: 'turn_complete', hasOutcome });
      }
    },
    transcript: (role, text) => {
      if (!isPhone) safeSend({ event: 'transcript', role, text });
    },
    outcome: () => {
      if (!isPhone) safeSend({ event: 'outcome', call: store.call(call.id) });
    },
    failure: (message) => finish(message, false),
  });
  const startupTimer = setTimeout(() => {
    if (!ready) finish('Voice session did not become ready in time.', false);
  }, 18000);
  const durationTimer = setTimeout(
    () => finish('Session reached the configured time limit.', false),
    config.MAX_CALL_SECONDS * 1000,
  );
  function finish(error?: string, phoneEnded = false) {
    if (ended) return;
    if (error && !isPhone) safeSend({ event: 'error', message: error });
    ended = true;
    clearTimeout(startupTimer);
    clearTimeout(durationTimer);
    clearTimeout(closingTimer);
    agent.close();
    frames.reset();
    const current = store.call(call.id)!;
    if (
      !['failed', 'busy', 'no_answer', 'completed'].includes(current.status)
    ) {
      store.update(call.id, {
        status: isPhone
          ? phoneEnded
            ? 'completed'
            : 'unknown'
          : error
            ? 'failed'
            : 'completed',
        error:
          error ??
          (isPhone && !phoneEnded
            ? 'Audio stream ended. Awaiting Exotel status; reconcile before retrying.'
            : null),
      });
    }
    if (socket.readyState === 1) socket.close(1000);
  }
  async function begin() {
    started = true;
    store.update(call.id, { status: 'active', error: null });
    ready = await agent.connect(
      store.order(call.orderId)!,
      call.agentSettings ?? store.settings(),
    );
    if (ready && !ended) {
      clearTimeout(startupTimer);
      if (!isPhone) safeSend({ event: 'ready' });
    }
  }
  socket.on('message', (data) => {
    try {
      const json: unknown = JSON.parse(data.toString());
      if (!isPhone) {
        const message = browserMessage.parse(json);
        if (message.event === 'stop') finish();
        else if (ready && message.event === 'audio')
          agent.audio(decodeAudio(message.data).toString('base64'));
        else if (ready && message.event === 'text') agent.text(message.text);
      } else {
        const message = exotelMessage.parse(json);
        if (message.event === 'start') {
          if (started || !message.start)
            throw new Error('Duplicate or invalid start.');
          const start = message.start;
          const current = store.call(call.id)!;
          if (
            start.account_sid !== config.EXOTEL_ACCOUNT_SID ||
            (current.providerSid && current.providerSid !== start.call_sid)
          )
            throw new Error('Call identity mismatch.');
          const rate = exotelSampleRate(start.media_format);
          streamSid = start.stream_sid;
          store.update(call.id, { providerSid: start.call_sid });
          inputConverter = new PcmResampler(rate, 16000);
          outputConverter = new PcmResampler(24000, rate);
          void begin().catch(() => finish('Voice startup failed.', false));
        } else if (message.event === 'media') {
          if (!started || message.stream_sid !== streamSid || !message.media)
            throw new Error('Invalid stream.');
          // Discard pre-ready audio instead of buffering an unbounded stream during connection setup.
          if (ready)
            agent.audio(
              inputConverter
                .push(decodeAudio(message.media.payload))
                .toString('base64'),
            );
        } else if (message.event === 'stop') {
          finish(undefined, message.stop?.reason === 'callended');
        } else if (message.event === 'mark' && message.mark?.name === 'goodbye')
          finish();
      }
    } catch {
      finish('Invalid voice-stream message.', false);
    }
  });
  socket.on('error', () => finish('Voice socket failed.', false));
  socket.on('close', () => finish());
  if (!isPhone)
    void begin().catch(() => finish('Voice startup failed.', false));
}
