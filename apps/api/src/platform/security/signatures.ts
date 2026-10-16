import { createHmac, timingSafeEqual } from 'node:crypto';

// Header format: `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`.
// Signing the timestamp with the body lets receivers reject replays outside the tolerance window.

function digest(secret: string, timestamp: number, body: string): Buffer {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest();
}

export function signBody(
  secret: string,
  body: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): string {
  return `t=${nowSeconds},v1=${digest(secret, nowSeconds, body).toString('hex')}`;
}

export function verifySignature(
  secret: string,
  header: string | undefined,
  body: string,
  toleranceSeconds: number,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  if (!header || header.length > 512) return false;
  const fields = new Map(
    header.split(',').map((part) => {
      const index = part.indexOf('=');
      return [part.slice(0, index).trim(), part.slice(index + 1).trim()];
    }),
  );
  const timestamp = Number(fields.get('t'));
  const signature = fields.get('v1') ?? '';
  if (!Number.isSafeInteger(timestamp) || !/^[0-9a-f]{64}$/.test(signature))
    return false;
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) return false;
  return timingSafeEqual(
    Buffer.from(signature, 'hex'),
    digest(secret, timestamp, body),
  );
}
