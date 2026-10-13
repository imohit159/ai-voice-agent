import { createHmac, timingSafeEqual } from 'node:crypto';

export function issueToken(
  secret: string,
  purpose: string,
  id: string,
  lifetimeSeconds: number,
): string {
  const payload = Buffer.from(
    JSON.stringify({ purpose, id, exp: Date.now() + lifetimeSeconds * 1000 }),
  ).toString('base64url');
  return `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
}
export function verifyToken(
  secret: string,
  token: string,
  purpose: string,
): string | null {
  if (token.length > 2048) return null;
  try {
    const [payload, signature, extra] = token.split('.');
    if (!payload || !signature || extra) return null;
    const expected = createHmac('sha256', secret).update(payload).digest();
    const received = Buffer.from(signature, 'base64url');
    if (
      received.length !== expected.length ||
      !timingSafeEqual(received, expected)
    )
      return null;
    const body = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return body.purpose === purpose &&
      typeof body.id === 'string' &&
      typeof body.exp === 'number' &&
      body.exp > Date.now()
      ? body.id
      : null;
  } catch {
    return null;
  }
}
