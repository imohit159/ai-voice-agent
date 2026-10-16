import { SIGNATURE_HEADER } from '@orderline/contracts/integration';
import { signBody } from '../../../platform/security/signatures.js';
import type { WebhookResponse } from '../service.js';

const TIMEOUT_MS = 10_000;

/** POSTs a signed JSON body. Redirects are refused so a result can only reach the configured URL. */
export async function postSignedJson(
  url: string,
  secret: string,
  body: string,
): Promise<WebhookResponse> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [SIGNATURE_HEADER]: signBody(secret, body),
      },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    await response.body?.cancel();
    return response.ok
      ? { ok: true }
      : { ok: false, error: `HTTP ${response.status}` };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error && error.name === 'TimeoutError'
          ? 'Timed out'
          : 'Network error',
    };
  }
}
