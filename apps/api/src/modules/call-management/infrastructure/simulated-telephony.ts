import { randomUUID } from 'node:crypto';
import {
  TelephonyError,
  type ProviderCallStatus,
  type Telephony,
} from '../telephony.js';

type Emit = (event: {
  attemptId: string;
  providerCallId: string;
  status: ProviderCallStatus;
}) => void;

const UNANSWERED_BY_LAST_DIGIT = new Map<string, ProviderCallStatus>([
  ['0', 'no_answer'],
  ['1', 'busy'],
  ['2', 'failed'],
]);

// Development stand-in for a telephony provider: no real call is placed.
// The last digit of the number picks the scenario so retries can be exercised:
// 0 → no answer, 1 → busy, 2 → failed, anything else → answered then hung up.
export function createSimulatedTelephony(
  emit: Emit,
  timing = { answerAfterMs: 2_000, hangUpAfterMs: 5_000 },
): Telephony {
  const calls = new Map<string, ProviderCallStatus>();
  const timers = new Set<NodeJS.Timeout>();
  const later = (delayMs: number, action: () => void) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      action();
    }, delayMs);
    timer.unref();
    timers.add(timer);
  };
  const report = (
    attemptId: string,
    providerCallId: string,
    status: ProviderCallStatus,
  ) => {
    calls.set(providerCallId, status);
    try {
      emit({ attemptId, providerCallId, status });
    } catch {
      // A rejected event is recovered by reconciliation, as with a real provider.
    }
  };

  return {
    name: 'simulated',
    async dial({ attemptId, phone }) {
      const providerCallId = `sim-${randomUUID()}`;
      calls.set(providerCallId, 'ringing');
      const unanswered = UNANSWERED_BY_LAST_DIGIT.get(phone.slice(-1));
      later(timing.answerAfterMs, () => {
        if (unanswered) return report(attemptId, providerCallId, unanswered);
        report(attemptId, providerCallId, 'in_progress');
        later(timing.hangUpAfterMs, () =>
          report(attemptId, providerCallId, 'completed'),
        );
      });
      return { providerCallId, status: 'ringing' };
    },
    async lookup(providerCallId) {
      const status = calls.get(providerCallId);
      if (!status) throw new TelephonyError('Unknown simulated call.', false);
      return status;
    },
    close() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
  };
}
