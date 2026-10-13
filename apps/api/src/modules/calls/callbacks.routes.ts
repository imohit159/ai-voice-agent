import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ACTIVE_STATUSES } from '@orderline/contracts';
import { config } from '../../config/index.js';
import { verifyToken } from '../../platform/security/tokens.js';
import type { Store } from '../../platform/persistence/store.js';
import type { createCalls } from './service.js';
import { ApiError } from '../../platform/http/errors.js';
import { callUrls } from './infrastructure/exotel.js';

const callbackSchema = z.object({
  CallSid: z.string().min(1).max(128),
  Status: z.string().max(30),
});

export function registerExotelRoutes(
  app: FastifyInstance,
  store: Store,
  calls: ReturnType<typeof createCalls>,
) {
  app.get('/hooks/exotel/stream-url', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { token, CallSid } = z
      .object({
        token: z.string().max(2048),
        CallSid: z.string().min(1).max(128),
      })
      .parse(request.query);
    if (
      !config.ENABLE_PHONE_CALLS ||
      !config.EXOTEL_FLOW_ID ||
      verifyToken(config.SESSION_SECRET, token, 'exotel-flow') !==
        config.EXOTEL_FLOW_ID
    ) {
      throw new ApiError(403, 'Flow is not authorized.');
    }
    const call = store.byProviderSid(CallSid);
    if (
      !call ||
      call.mode !== 'phone' ||
      !ACTIVE_STATUSES.includes(call.status) ||
      Date.now() - Date.parse(call.createdAt) >
        (config.MAX_CALL_SECONDS + 120) * 1000
    ) {
      throw new ApiError(403, 'Call is not authorized.');
    }
    app.log.info({ callId: call.id }, 'Exotel flow resolved media endpoint');
    return { url: callUrls(call.id).stream };
  });
  app.post(
    '/hooks/exotel',
    { config: { rateLimit: { max: 300, timeWindow: '1 minute' } } },
    async (request) => {
      const { token } = z
        .object({ token: z.string().max(2048) })
        .parse(request.query);
      const id = verifyToken(config.SESSION_SECRET, token, 'exotel-callback');
      if (!id) throw new ApiError(403, 'Invalid callback credentials.');
      const body = callbackSchema.parse(request.body);
      calls.receiveStatus(id, body.CallSid, body.Status);
      return { received: true };
    },
  );
}
