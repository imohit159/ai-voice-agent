import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type {
  CallAttemptDetail,
  CallAttemptSummary,
  PracticeAnswer,
  PracticeSession,
} from '@orderline/contracts/api';
import type { CallRequest } from '@orderline/contracts/integration';
import { ApiError } from '../../platform/http/errors.js';
import type { CallManagement } from './service.js';
import type { VoiceAgentClient } from './infrastructure/voice-agent.js';

const idParams = z.object({ id: z.uuid() });
const offerSchema = z
  .object({ sdp: z.string().min(1).max(100_000), type: z.literal('offer') })
  .strict();
const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

type Options = {
  practiceOrder: () => Pick<CallRequest, 'customer' | 'order'>;
  issueSessionToken: (attemptId: string) => string;
  voiceAgent: VoiceAgentClient;
};

/** Operator dashboard endpoints; authentication and origin checks apply to all /api routes. */
export function registerOperatorRoutes(
  app: FastifyInstance,
  calls: CallManagement,
  options: Options,
) {
  app.get(
    '/api/call-attempts',
    async (request): Promise<{ attempts: CallAttemptSummary[] }> => {
      const { limit } = listQuery.parse(request.query);
      return { attempts: calls.listAttempts(limit) };
    },
  );
  app.get(
    '/api/call-attempts/:id',
    async (request): Promise<CallAttemptDetail> => {
      const { id } = idParams.parse(request.params);
      return calls.attemptDetail(id);
    },
  );
  app.post(
    '/api/practice-sessions',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (): Promise<PracticeSession> => ({
      attemptId: (await calls.startPracticeSession(options.practiceOrder())).id,
    }),
  );
  app.post(
    '/api/practice-sessions/:id/offer',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request): Promise<PracticeAnswer> => {
      const { id } = idParams.parse(request.params);
      const { sdp } = offerSchema.parse(request.body);
      const { attempt } = calls.attemptDetail(id);
      if (attempt.source !== 'practice' || attempt.status !== 'in_progress')
        throw new ApiError(409, 'This practice session is no longer open.');
      // The session token stays server side: the browser only exchanges SDP.
      return options.voiceAgent.practiceOffer({
        attemptId: id,
        sessionToken: options.issueSessionToken(id),
        sdp,
      });
    },
  );
}
