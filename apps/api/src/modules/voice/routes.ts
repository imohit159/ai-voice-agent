import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../../config/index.js';
import { verifyToken } from '../../platform/security/tokens.js';
import type { Store } from '../../platform/persistence/store.js';
import type { OperatorSession } from '../../platform/http/security.js';
import { ApiError } from '../../platform/http/errors.js';
import { attachVoice } from './streams.js';

export function registerVoiceRoutes(
  app: FastifyInstance,
  store: Store,
  { origin, isLoggedIn }: OperatorSession,
  voice: typeof attachVoice,
) {
  app.get(
    '/ws/browser',
    {
      websocket: true,
      preValidation: async (request) => {
        if (
          request.headers.origin !== origin ||
          !isLoggedIn(request.cookies.session)
        )
          throw new ApiError(403, 'Voice session is not authorized.');
        const { token } = z
          .object({ token: z.string().max(2048) })
          .parse(request.query);
        const id = verifyToken(config.SESSION_SECRET, token, 'browser');
        const call = id ? store.call(id) : null;
        if (!call || call.mode !== 'browser' || !store.claim(call.id))
          throw new ApiError(403, 'Voice session expired or already used.');
      },
    },
    (socket, request) => {
      const { token } = request.query as { token: string };
      const id = verifyToken(config.SESSION_SECRET, token, 'browser')!;
      voice(socket, store.call(id)!, store);
    },
  );
  app.get(
    '/ws/exotel',
    {
      websocket: true,
      preValidation: async (request) => {
        const { token } = z
          .object({ token: z.string().max(2048) })
          .parse(request.query);
        const id = verifyToken(config.SESSION_SECRET, token, 'exotel-stream');
        const call = id ? store.call(id) : null;
        if (
          !config.ENABLE_PHONE_CALLS ||
          !call ||
          call.mode !== 'phone' ||
          !store.claim(call.id)
        )
          throw new ApiError(403, 'Stream is not authorized.');
      },
    },
    (socket, request) => {
      const { token } = request.query as { token: string };
      const id = verifyToken(config.SESSION_SECRET, token, 'exotel-stream')!;
      voice(socket, store.call(id)!, store);
    },
  );
}
