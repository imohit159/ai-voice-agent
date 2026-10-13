import { config } from '../../config/index.js';
import { verifyToken } from '../../platform/security/tokens.js';
import type { OperatorSession } from '../../platform/http/security.js';

export { registerAuthRoutes } from './routes.js';

export function createOperatorSession(): OperatorSession {
  return {
    origin: new URL(config.APP_ORIGIN).origin,
    isLoggedIn: (token) =>
      Boolean(
        token &&
        verifyToken(config.SESSION_SECRET, token, 'operator') === 'admin',
      ),
  };
}
