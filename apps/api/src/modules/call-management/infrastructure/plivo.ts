import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { FinalAttemptStatus } from '@orderline/contracts/integration';
import {
  TelephonyError,
  type ProviderCallState,
  type Telephony,
} from '../telephony.js';

const API_BASE = 'https://api.plivo.com/v1/Account';
const TIMEOUT_MS = 10_000;
// Plivo's default of 120 s keeps an unanswered line ringing far longer than a person would.
const RING_TIMEOUT_SECONDS = 40;

// Hangup cause codes from Plivo's "Standard Plivo Hangup Causes" reference.
const BUSY_CAUSES = new Set([3010, 3020, 3100, 3110]); // busy, rejected, busy everywhere, declined
const NO_ANSWER_CAUSES = new Set([3000, 6010]); // no answer, ring timeout

export const PLIVO_CALLBACK_EVENTS = ['ring', 'answer', 'hangup'] as const;
export type PlivoCallbackEvent = (typeof PLIVO_CALLBACK_EVENTS)[number];

export function plivoCallbackUrl(
  publicBaseUrl: string,
  event: PlivoCallbackEvent,
  attemptId: string,
): string {
  const url = new URL(`/hooks/plivo/${event}`, publicBaseUrl);
  url.searchParams.set('attempt', attemptId);
  return url.toString();
}

export function plivoFinalStatus(call: {
  answered: boolean;
  causeCode: number | null;
  callStatus?: string;
}): FinalAttemptStatus {
  if (call.answered) return 'completed';
  const code = call.causeCode ?? -1;
  if (BUSY_CAUSES.has(code) || call.callStatus === 'busy') return 'busy';
  if (
    NO_ANSWER_CAUSES.has(code) ||
    call.callStatus === 'no-answer' ||
    call.callStatus === 'timeout'
  )
    return 'no_answer';
  return 'failed';
}

/**
 * Plivo V3 webhook signature, mirroring plivo-python's signature_v3:
 * HMAC-SHA256(authToken, `${canonicalUrl}.${nonce}`), base64. For POST the
 * canonical URL is the URL with its query sorted, then `?`/`.` separators, then
 * the body parameters sorted by name and concatenated as name+value.
 */
export function verifyPlivoSignature(input: {
  authToken: string;
  method: 'GET' | 'POST';
  url: string;
  params: Record<string, string>;
  nonce: string | undefined;
  signature: string | undefined;
}): boolean {
  const { nonce, signature } = input;
  if (!nonce || !signature || signature.length > 2048) return false;
  const url = new URL(input.url);
  const query = new Map<string, string[]>();
  url.searchParams.forEach((value, key) =>
    query.set(key, [...(query.get(key) ?? []), value]),
  );
  const queryString = [...query.keys()]
    .sort()
    .flatMap((key) =>
      query
        .get(key)!
        .sort()
        .map((value) => `${key}=${value}`),
    )
    .join('&');
  let canonical = `${url.protocol}//${url.host}${url.pathname}`;
  if (input.method === 'GET') {
    if (queryString) canonical += `?${queryString}`;
  } else {
    const keys = Object.keys(input.params).sort();
    if (queryString || keys.length) canonical += `?${queryString}`;
    if (queryString && keys.length) canonical += '.';
    canonical += keys.map((key) => `${key}${input.params[key]}`).join('');
  }
  const expected = createHmac('sha256', input.authToken)
    .update(`${canonical}.${nonce}`)
    .digest();
  return signature.split(',').some((candidate) => {
    const received = Buffer.from(candidate.trim(), 'base64');
    return (
      received.length === expected.length && timingSafeEqual(received, expected)
    );
  });
}

const escapeXml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&apos;',
      })[char]!,
  );

export const PLIVO_HANGUP_XML =
  '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>';

/** Bidirectional μ-law stream; the call ends when the voice agent closes the stream. */
export function plivoStreamXml(
  streamUrl: string,
  extraHeaders: Record<string, string>,
): string {
  const headers = Object.entries(extraHeaders)
    .map(([key, value]) => `${key}=${value}`)
    .join(';');
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Stream bidirectional="true" keepCallAlive="true" contentType="audio/x-mulaw;rate=8000" extraHeaders="${escapeXml(headers)}">${escapeXml(streamUrl)}</Stream></Response>`;
}

const dialResponse = z.object({ request_uuid: z.string().min(1).max(128) });
const callRecord = z.object({
  answer_time: z.string().nullish(),
  bill_duration: z.coerce.number().nullish(),
  hangup_cause_code: z.coerce.number().nullish(),
  hangup_cause_name: z.string().nullish(),
});
const liveCall = z.object({ call_status: z.string() });

export function createPlivoTelephony(options: {
  authId: string;
  authToken: string;
  fromNumber: string;
  publicBaseUrl: string;
  maxCallSeconds: number;
}): Telephony {
  const authorization = `Basic ${Buffer.from(`${options.authId}:${options.authToken}`).toString('base64')}`;
  const endpoint = (path: string) =>
    `${API_BASE}/${encodeURIComponent(options.authId)}/${path}`;
  const request = (path: string, init: RequestInit = {}) =>
    fetch(endpoint(path), {
      ...init,
      headers: {
        authorization,
        accept: 'application/json',
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

  return {
    name: 'plivo',

    async dial({ attemptId, phone }) {
      let response: Response;
      try {
        response = await request('Call/', {
          method: 'POST',
          body: JSON.stringify({
            from: options.fromNumber.replace(/^\+/, ''),
            to: phone.replace(/^\+/, ''),
            answer_url: plivoCallbackUrl(
              options.publicBaseUrl,
              'answer',
              attemptId,
            ),
            answer_method: 'POST',
            ring_url: plivoCallbackUrl(
              options.publicBaseUrl,
              'ring',
              attemptId,
            ),
            ring_method: 'POST',
            hangup_url: plivoCallbackUrl(
              options.publicBaseUrl,
              'hangup',
              attemptId,
            ),
            hangup_method: 'POST',
            ring_timeout: RING_TIMEOUT_SECONDS,
            time_limit: options.maxCallSeconds,
          }),
        });
      } catch {
        throw new TelephonyError(
          'Plivo did not respond to the dial request.',
          true,
        );
      }
      // 4xx: Plivo rejected the request, so no call exists. 5xx: it may exist.
      if (response.status >= 400 && response.status < 500)
        throw new TelephonyError(
          `Plivo rejected the call (HTTP ${response.status}).`,
          false,
        );
      const parsed = dialResponse.safeParse(
        await response.json().catch(() => null),
      );
      if (!response.ok || !parsed.success)
        throw new TelephonyError(
          `Plivo dial result is unclear (HTTP ${response.status}).`,
          true,
        );
      // Accepted for dialling; "ringing" is the closest neutral state until callbacks arrive.
      return { providerCallId: parsed.data.request_uuid, status: 'ringing' };
    },

    async lookup({ providerLegId }): Promise<ProviderCallState> {
      if (!providerLegId)
        throw new TelephonyError(
          'Plivo has not reported a call leg yet.',
          true,
        );
      const id = encodeURIComponent(providerLegId);
      try {
        const record = await request(`Call/${id}/`);
        if (record.ok) {
          const call = callRecord.parse(await record.json());
          return {
            status: plivoFinalStatus({
              answered:
                Boolean(call.answer_time) || (call.bill_duration ?? 0) > 0,
              causeCode: call.hangup_cause_code ?? null,
            }),
            detail: call.hangup_cause_name ?? null,
          };
        }
        if (record.status !== 404) throw new Error(`HTTP ${record.status}`);
        const live = await request(`Call/${id}/?status=live`);
        if (live.ok) {
          const call = liveCall.parse(await live.json());
          return {
            status:
              call.call_status === 'in-progress' ? 'in_progress' : 'ringing',
          };
        }
        throw new Error(`HTTP ${live.status}`);
      } catch {
        // A just-ended call can be missing from both views briefly; retry on the next pass.
        throw new TelephonyError(
          'Plivo call state is not available yet.',
          true,
        );
      }
    },
  };
}
