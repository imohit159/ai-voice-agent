import type { FastifyInstance } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  outcomeReportSchema,
  transcriptBatchSchema,
  voiceSessionClaimSchema,
  voiceSessionEndSchema,
} from '@orderline/contracts/voice';
import { ApiError } from '../../platform/http/errors.js';
import type { VoiceSessions } from './voice-session.service.js';

const params = z.object({ attemptId: z.uuid() });

function bearerMatches(header: string | undefined, token: string): boolean {
  const received = Buffer.from(header?.replace(/^Bearer /, '') ?? '');
  const expected = Buffer.from(token);
  return (
    received.length === expected.length && timingSafeEqual(received, expected)
  );
}

/**
 * Internal API for the voice agent. It must stay off the public reverse proxy;
 * the shared service token is a second line of defence, not the only one.
 */
export async function registerVoiceSessionRoutes(
  app: FastifyInstance,
  sessions: VoiceSessions,
  internalToken: string,
) {
  await app.register(async (scope) => {
    scope.addHook('onRequest', async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!bearerMatches(request.headers.authorization, internalToken))
        throw new ApiError(401, 'Service authentication required.');
    });
    const limits = {
      config: { rateLimit: { max: 3_000, timeWindow: '1 minute' } },
    };
    scope.post('/internal/v1/voice-sessions/claim', limits, async (request) =>
      sessions.claim(voiceSessionClaimSchema.parse(request.body)),
    );
    scope.post(
      '/internal/v1/voice-sessions/:attemptId/transcript',
      limits,
      async (request, reply) => {
        const { attemptId } = params.parse(request.params);
        sessions.appendTranscript(
          attemptId,
          transcriptBatchSchema.parse(request.body),
        );
        return reply.code(204).send();
      },
    );
    scope.post(
      '/internal/v1/voice-sessions/:attemptId/outcome',
      limits,
      async (request) => {
        const { attemptId } = params.parse(request.params);
        return sessions.recordOutcome(
          attemptId,
          outcomeReportSchema.parse(request.body),
        );
      },
    );
    scope.post(
      '/internal/v1/voice-sessions/:attemptId/end',
      limits,
      async (request, reply) => {
        const { attemptId } = params.parse(request.params);
        sessions.end(attemptId, voiceSessionEndSchema.parse(request.body));
        return reply.code(204).send();
      },
    );
  });
}
