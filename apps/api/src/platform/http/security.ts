import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { config } from '../../config/index.js';
import { ApiError } from './errors.js';

export interface OperatorSession {
  origin: string;
  isLoggedIn: (token?: string) => boolean;
}

export function registerHttpSecurity(
  app: FastifyInstance,
  { origin, isLoggedIn }: OperatorSession,
) {
  const allowedHosts = new Set([
    'localhost',
    '127.0.0.1',
    new URL(origin).hostname,
  ]);
  if (config.PUBLIC_BASE_URL)
    allowedHosts.add(new URL(config.PUBLIC_BASE_URL).hostname);
  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Permissions-Policy', 'microphone=(self)');
    if (request.url.startsWith('/api/')) {
      reply.header('Cache-Control', 'no-store');
      let hostname = '';
      try {
        hostname = new URL(`http://${request.headers.host}`).hostname;
      } catch {
        /* rejected below */
      }
      if (!allowedHosts.has(hostname))
        throw new ApiError(403, 'Unrecognized host.');
      if (request.method !== 'GET' && request.headers.origin !== origin)
        throw new ApiError(403, 'Invalid request origin.');
      const path = request.url.split('?')[0];
      if (
        path !== '/api/login' &&
        path !== '/api/session' &&
        !isLoggedIn(request.cookies.session)
      )
        throw new ApiError(401, 'Sign in to continue.');
    }
  });
  app.setErrorHandler((error, _request, reply) => {
    // Field paths only: issue messages can echo submitted values.
    if (error instanceof ZodError)
      return reply.code(400).send({
        error: 'Invalid request. Check the supplied fields.',
        fields: [...new Set(error.issues.map((i) => i.path.join('.')))],
      });
    const status =
      error instanceof Error &&
      'statusCode' in error &&
      typeof error.statusCode === 'number'
        ? error.statusCode
        : 500;
    if (status >= 500)
      app.log.error(
        { errorType: error instanceof Error ? error.name : 'UnknownError' },
        'Request failed',
      );
    return reply.code(status).send({
      error:
        status >= 500
          ? 'The request failed. Check server configuration and retry safely.'
          : error instanceof Error
            ? error.message
            : 'Request rejected.',
    });
  });
}
