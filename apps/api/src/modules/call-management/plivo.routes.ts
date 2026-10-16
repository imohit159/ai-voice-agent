import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ApiError } from '../../platform/http/errors.js';
import { issueToken } from '../../platform/security/tokens.js';
import {
  PLIVO_CALLBACK_EVENTS,
  PLIVO_HANGUP_XML,
  plivoFinalStatus,
  plivoStreamXml,
  verifyPlivoSignature,
  type PlivoCallbackEvent,
} from './infrastructure/plivo.js';
import type { CallManagement } from './service.js';
import type { ProviderEvent } from './telephony.js';

export const VOICE_SESSION_TOKEN_PURPOSE = 'voice-session';

const query = z.object({ attempt: z.uuid() });
const params = z.object({ event: z.enum(PLIVO_CALLBACK_EVENTS) });
const callback = z.object({
  CallUUID: z.string().min(1).max(128),
  RequestUUID: z.string().min(1).max(128).optional(),
  CallStatus: z.string().max(40).optional(),
  AnswerTime: z.string().max(64).optional(),
  BillDuration: z.coerce.number().optional(),
  HangupCauseCode: z.coerce.number().optional(),
  HangupCauseName: z.string().max(300).optional(),
});

type Options = {
  authToken: string;
  publicBaseUrl: string;
  streamUrl: string;
  sessionSecret: string;
  maxCallSeconds: number;
};

function toEvent(
  event: PlivoCallbackEvent,
  attemptId: string,
  body: z.infer<typeof callback>,
): ProviderEvent {
  const identity = {
    attemptId,
    providerCallId: body.RequestUUID,
    providerLegId: body.CallUUID,
  };
  if (event === 'ring') return { ...identity, status: 'ringing' };
  if (event === 'answer') return { ...identity, status: 'in_progress' };
  return {
    ...identity,
    status: plivoFinalStatus({
      answered: Boolean(body.AnswerTime) || (body.BillDuration ?? 0) > 0,
      causeCode: body.HangupCauseCode ?? null,
      callStatus: body.CallStatus,
    }),
    detail: body.HangupCauseName ?? null,
  };
}

export function registerPlivoRoutes(
  app: FastifyInstance,
  calls: Pick<CallManagement, 'applyProviderEvent'>,
  options: Options,
) {
  const origin = new URL(options.publicBaseUrl).origin;
  const authenticate = (request: FastifyRequest) => {
    const body = (request.body ?? {}) as Record<string, string>;
    const header = (name: string) => {
      const value = request.headers[name];
      return typeof value === 'string' ? value : undefined;
    };
    // Plivo signs the public URL it called; behind the reverse proxy only the path is local.
    if (
      !verifyPlivoSignature({
        authToken: options.authToken,
        method: 'POST',
        url: `${origin}${request.url}`,
        params: body,
        nonce: header('x-plivo-signature-v3-nonce'),
        signature: header('x-plivo-signature-v3'),
      })
    )
      throw new ApiError(403, 'Invalid Plivo signature.');
    return body;
  };

  app.post(
    '/hooks/plivo/:event',
    { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { event } = params.parse(request.params);
      const { attempt } = query.parse(request.query);
      const body = callback.parse(authenticate(request));
      if (event !== 'answer') {
        calls.applyProviderEvent(toEvent(event, attempt, body));
        return reply.code(204).send();
      }
      // The answer response decides what the customer hears, so any failure hangs up
      // rather than leaving an unattended line open.
      reply.type('application/xml');
      try {
        const answered = calls.applyProviderEvent(
          toEvent(event, attempt, body),
        );
        if (answered.status !== 'in_progress') return PLIVO_HANGUP_XML;
        return plivoStreamXml(options.streamUrl, {
          attemptId: answered.id,
          sessionToken: issueToken(
            options.sessionSecret,
            VOICE_SESSION_TOKEN_PURPOSE,
            answered.id,
            options.maxCallSeconds + 120,
          ),
        });
      } catch (error) {
        request.log.warn(
          { attemptId: attempt, errorType: (error as Error).name },
          'Plivo answer rejected; hanging up',
        );
        return PLIVO_HANGUP_XML;
      }
    },
  );
}
