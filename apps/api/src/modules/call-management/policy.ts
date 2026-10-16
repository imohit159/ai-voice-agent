import type {
  CallRequestStatus,
  FinalAttemptStatus,
} from '@orderline/contracts/integration';

export interface CallingPolicy {
  /** Inclusive start and exclusive end of calling hours, in IST. */
  startHour: number;
  endHour: number;
  /** Delay before attempt n+1 is retryDelaysMinutes[n-1]. */
  retryDelaysMinutes: readonly number[];
}

// India observes no daylight saving, so IST is a fixed UTC offset.
const IST_OFFSET_MS = 330 * 60_000;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** The earliest instant at or after `at` that falls inside calling hours. */
export function nextCallableTime(at: number, policy: CallingPolicy): number {
  const local = at + IST_OFFSET_MS;
  const dayStart = Math.floor(local / DAY_MS) * DAY_MS;
  const opens = dayStart + policy.startHour * HOUR_MS;
  const closes = dayStart + policy.endHour * HOUR_MS;
  if (local < opens) return opens - IST_OFFSET_MS;
  if (local >= closes) return opens + DAY_MS - IST_OFFSET_MS;
  return at;
}

export const isCallable = (at: number, policy: CallingPolicy) =>
  nextCallableTime(at, policy) === at;

export function planAfterAttempt(
  attempt: {
    status: FinalAttemptStatus;
    number: number;
    endedAt: number;
  },
  request: { maxAttempts: number; notAfter: number },
  policy: CallingPolicy,
): { status: CallRequestStatus; nextAttemptAt: number | null } {
  if (attempt.status === 'completed')
    return { status: 'completed', nextAttemptAt: null };
  if (attempt.number >= request.maxAttempts)
    return { status: 'exhausted', nextAttemptAt: null };
  const delays = policy.retryDelaysMinutes;
  const delay = delays[Math.min(attempt.number, delays.length) - 1]!;
  const next = nextCallableTime(attempt.endedAt + delay * 60_000, policy);
  return next < request.notAfter
    ? { status: 'pending', nextAttemptAt: next }
    : { status: 'expired', nextAttemptAt: null };
}
