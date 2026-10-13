import { createHmac, timingSafeEqual, scryptSync } from 'node:crypto';

export function passwordChecker(
  password: string,
  salt: string,
): (candidate: string) => boolean {
  const hash = scryptSync(password, salt, 32);
  // Derive once at startup; each bounded login attempt uses a constant-time HMAC comparison.
  return (candidate) => {
    const left = createHmac('sha256', hash).update(candidate).digest();
    const right = createHmac('sha256', hash).update(password).digest();
    return timingSafeEqual(left, right);
  };
}
