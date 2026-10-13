import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../../config/index.js';
import { issueToken } from '../../platform/security/tokens.js';
import { passwordChecker } from './password.js';
import { ApiError } from '../../platform/http/errors.js';
import type { OperatorSession } from '../../platform/http/security.js';

export function registerAuthRoutes(
  app: FastifyInstance,
  { origin, isLoggedIn }: OperatorSession,
) {
  const checkPassword = passwordChecker(
    config.ADMIN_PASSWORD,
    config.SESSION_SECRET,
  );
  const secure = origin.startsWith('https:');
  app.get('/api/session', async (request) => ({
    authenticated: Boolean(isLoggedIn(request.cookies.session)),
  }));
  app.post(
    '/api/login',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { password } = z
        .object({ password: z.string().min(1).max(256) })
        .strict()
        .parse(request.body);
      if (!checkPassword(password))
        throw new ApiError(401, 'Incorrect operator password.');
      reply.setCookie(
        'session',
        issueToken(config.SESSION_SECRET, 'operator', 'admin', 28800),
        {
          httpOnly: true,
          secure,
          sameSite: 'strict',
          path: '/',
          maxAge: 28800,
        },
      );
      return { authenticated: true };
    },
  );
  app.post('/api/logout', async (_request, reply) => {
    reply.clearCookie('session', { path: '/' });
    return { authenticated: false };
  });
}
