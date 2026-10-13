import { BrowserVoice } from '../../voice.js';
import type { ApiClient } from '../../api/client.js';
import { badge, transcriptHtml } from '../../ui/format.js';
import type { PracticeState } from './view.js';

export function createPracticeController(options: {
  api: ApiClient;
  isBusy: () => boolean;
  setBusy: (busy: boolean) => void;
  render: () => void;
  toast: (message: string) => void;
  onCall: (id: string) => void;
  onEnded: () => void;
}) {
  let voice: BrowserVoice | null = null;
  let status = 'idle';
  let transcript: PracticeState['transcript'] = [];
  let outcome: string | null = null;

  async function start(orderId: string) {
    if (options.isBusy() || voice) return;
    options.setBusy(true);
    transcript = [];
    outcome = null;
    const instance = new BrowserVoice({
      status: (next) => {
        status = next;
        if (next === 'ended') {
          voice = null;
          options.setBusy(false);
          options.onEnded();
        }
        const element = document.querySelector('#voice-status');
        if (element)
          element.textContent = {
            connecting: 'Connecting to your agent…',
            listening: 'Listening to you',
            speaking: 'Your agent is speaking',
            ended: 'Practice complete',
          }[next];
      },
      transcript: (role, text) => {
        transcript.push({ role, text });
        const element = document.querySelector('#live-transcript');
        if (element) {
          element.innerHTML = transcriptHtml(transcript);
          element.scrollTop = element.scrollHeight;
        }
      },
      outcome: (value) => {
        outcome = value;
        const element = document.querySelector('#live-result');
        if (element) element.innerHTML = badge(value);
      },
      error: options.toast,
    });
    voice = instance;
    status = 'connecting';
    options.render();
    try {
      await instance.prepare();
      if (voice !== instance) return;
      const result = await options.api.startCall({
        orderId,
        mode: 'browser',
        requestKey: crypto.randomUUID(),
      });
      // Preparing the microphone and requesting a token can both outlive End practice.
      if (voice !== instance) return;
      if (!result.token) throw new Error('Voice session could not be started.');
      options.onCall(result.call.id);
      instance.connect(result.token);
      options.setBusy(false);
    } catch (error) {
      instance.stop();
      options.toast(
        error instanceof Error ? error.message : 'Could not start practice.',
      );
    }
  }

  return {
    start,
    stop: () => voice?.stop(),
    snapshot: (): PracticeState => ({
      running: voice !== null,
      status,
      transcript,
      outcome,
    }),
  };
}
