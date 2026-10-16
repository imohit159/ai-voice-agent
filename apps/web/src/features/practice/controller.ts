import type { ApiClient } from '../../api/client.js';
import { transcriptHtml } from '../../ui/format.js';
import type { PracticeState } from './view.js';
import { PracticeConnection } from './webrtc.js';

const TRANSCRIPT_POLL_MS = 2_000;

export function createPracticeController(options: {
  api: ApiClient;
  isBusy: () => boolean;
  setBusy: (busy: boolean) => void;
  render: () => void;
  toast: (message: string) => void;
  onCall: (id: string) => void;
  onEnded: () => void;
}) {
  let connection: PracticeConnection | null = null;
  let status: PracticeState['status'] = 'idle';
  let transcript: PracticeState['transcript'] = [];
  let poll: number | undefined;

  function setStatus(next: PracticeState['status']) {
    status = next;
    const element = document.querySelector('#voice-status');
    if (element)
      element.textContent = {
        idle: 'Ready for a conversation',
        connecting: 'Connecting to your agent…',
        live: 'Live: speak naturally',
        ended: 'Practice complete',
      }[next];
  }

  // Node stores what was said; the panel shows it as it arrives.
  function followTranscript(attemptId: string) {
    poll = window.setInterval(async () => {
      try {
        transcript = (await options.api.callAttempt(attemptId)).transcript;
        const element = document.querySelector('#live-transcript');
        if (element) {
          element.innerHTML = transcriptHtml(transcript);
          element.scrollTop = element.scrollHeight;
        }
      } catch {
        // The next poll retries; the call itself is unaffected.
      }
    }, TRANSCRIPT_POLL_MS);
  }

  async function start() {
    if (options.isBusy() || connection) return;
    options.setBusy(true);
    transcript = [];
    const current = new PracticeConnection(() => {
      window.clearInterval(poll);
      connection = null;
      setStatus('ended');
      options.setBusy(false);
      options.onEnded();
    });
    connection = current;
    setStatus('connecting');
    options.render();
    try {
      const { attemptId } = await options.api.startPractice();
      options.onCall(attemptId);
      await current.start(
        async (sdp) => (await options.api.practiceOffer(attemptId, sdp)).sdp,
      );
      if (connection !== current) return;
      setStatus('live');
      options.setBusy(false);
      followTranscript(attemptId);
    } catch (error) {
      current.stop();
      options.toast(
        error instanceof Error ? error.message : 'Could not start practice.',
      );
    }
  }

  return {
    start,
    stop: () => connection?.stop(),
    snapshot: (): PracticeState => ({
      running: connection !== null,
      status,
      transcript,
    }),
  };
}
