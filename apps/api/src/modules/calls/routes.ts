import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Call } from '@orderline/contracts';
import type {
  StartCallRequest,
  StartCallResponse,
  CallDetail,
} from '@orderline/contracts/api';
import { config } from '../../config/index.js';
import { issueToken } from '../../platform/security/tokens.js';
import type { Store } from '../../platform/persistence/store.js';
import type { createCalls } from './service.js';
import { ApiError } from '../../platform/http/errors.js';

const callRequest = z
  .object({
    orderId: z.string().min(1).max(80),
    mode: z.enum(['browser', 'phone']),
    requestKey: z.uuid(),
  })
  .strict() satisfies z.ZodType<StartCallRequest>;
const idParams = z.object({ id: z.uuid() });

export function registerCallRoutes(
  app: FastifyInstance,
  store: Store,
  calls: ReturnType<typeof createCalls>,
) {
  app.get('/api/calls/:id', async (request): Promise<CallDetail> => {
    const { id } = idParams.parse(request.params);
    const call = store.call(id);
    if (!call) throw new ApiError(404, 'Call not found.');
    return { call, transcript: store.transcripts(id) };
  });
  const browserResponse = (call: Call): StartCallResponse => ({
    call,
    token:
      call.mode === 'browser' && call.status === 'queued'
        ? issueToken(config.SESSION_SECRET, 'browser', call.id, 120)
        : undefined,
  });
  app.post('/api/calls', async (request) => {
    const body = callRequest.parse(request.body);
    return browserResponse(await calls.start(body));
  });
  app.post('/api/calls/:id/reconcile', async (request) => {
    const { id } = idParams.parse(request.params);
    return { call: await calls.reconcile(id) };
  });
}
