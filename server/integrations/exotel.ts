import { z } from 'zod';
import { config } from '../config.js';
import { issueToken } from '../security.js';
import type { Call } from '../../shared/domain.js';

export class ProviderError extends Error {
  constructor(message: string, public uncertain: boolean) { super(message); }
}
const responseSchema = z.object({ Call: z.object({ Sid: z.string().min(1).max(128), Status: z.string() }) });
const host = () => config.EXOTEL_REGION === 'in' ? 'api.in.exotel.com' : 'api.exotel.com';
const headers = () => ({ Authorization: `Basic ${Buffer.from(`${config.EXOTEL_API_KEY}:${config.EXOTEL_API_TOKEN}`).toString('base64')}` });
export function flowResolverUrl() {
  if (!config.EXOTEL_FLOW_ID) throw new Error('An Exotel flow ID is required.');
  const url = new URL('/hooks/exotel/stream-url', config.PUBLIC_BASE_URL);
  // The applet cannot hold a per-call URL. This scoped, one-day token only resolves known active calls.
  url.searchParams.set('token', issueToken(config.SESSION_SECRET, 'exotel-flow', config.EXOTEL_FLOW_ID, 86400));
  return url.toString();
}
export function callUrls(callId: string) {
  const stream = new URL('/ws/exotel', config.PUBLIC_BASE_URL);
  stream.protocol = 'wss:';
  stream.searchParams.set('sample-rate', '16000');
  stream.searchParams.set('token', issueToken(config.SESSION_SECRET, 'exotel-stream', callId, config.MAX_CALL_SECONDS + 120));
  const callback = new URL('/hooks/exotel', config.PUBLIC_BASE_URL);
  callback.searchParams.set('token', issueToken(config.SESSION_SECRET, 'exotel-callback', callId, 86400));
  return { stream: stream.toString(), callback: callback.toString() };
}
export async function dial(call: Call, phone: string) {
  const urls = callUrls(call.id);
  // Direct streams use multipart; App Bazaar flow calls use the legacy URL-encoded form parser.
  const form = new FormData();
  const fields = {
    From: phone, CallerId: config.EXOTEL_CALLER_ID,
    Record: 'false',
    TimeLimit: String(config.MAX_CALL_SECONDS), CustomField: call.id,
    StatusCallback: urls.callback,
  };
  for (const [name, value] of Object.entries(fields)) form.append(name, value);
  if (config.EXOTEL_FLOW_ID) {
    form.append('Url', `http://my.exotel.com/${encodeURIComponent(config.EXOTEL_ACCOUNT_SID)}/exoml/start_voice/${config.EXOTEL_FLOW_ID}`);
    form.append('CallType', 'trans');
    form.append('StatusCallbackEvents', 'terminal');
  } else {
    form.append('StreamUrl', urls.stream);
    form.append('StreamType', 'bidirectional');
    form.append('StatusCallbackEvents[]', 'terminal');
    form.append('StatusCallbackEvents[]', 'answered');
  }
  try {
    const response = await fetch(`https://${host()}/v1/Accounts/${encodeURIComponent(config.EXOTEL_ACCOUNT_SID)}/Calls/connect.json`, {
      method: 'POST', headers: { ...headers(), Accept: 'application/json' },
      body: config.EXOTEL_FLOW_ID ? new URLSearchParams([...form.entries()] as [string, string][]) : form,
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) throw new ProviderError(`Exotel rejected the call (HTTP ${response.status}). Check account credentials, balance, and AgentStream access.`, response.status >= 500);
    const parsed = responseSchema.safeParse(await response.json());
    if (!parsed.success) throw new ProviderError('Exotel returned an unexpected response. Reconcile the attempt before retrying.', true);
    return parsed.data.Call;
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    // A timed-out POST may still have placed a call. Never retry it automatically.
    throw new ProviderError('Could not determine whether Exotel placed the call. Check Exotel call logs before retrying.', true);
  }
}
export async function lookup(sid: string) {
  const response = await fetch(`https://${host()}/v1/Accounts/${encodeURIComponent(config.EXOTEL_ACCOUNT_SID)}/Calls/${encodeURIComponent(sid)}.json`, {
    headers: headers(), signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new ProviderError(`Could not read Exotel call status (HTTP ${response.status}).`, false);
  const parsed = responseSchema.safeParse(await response.json());
  if (!parsed.success || parsed.data.Call.Sid !== sid) throw new ProviderError('Unexpected Exotel call-status response.', false);
  return parsed.data.Call;
}
