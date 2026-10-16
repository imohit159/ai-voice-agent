import type { FastifyInstance } from 'fastify';
import {
  SIGNATURE_HEADER,
  SIGNATURE_TOLERANCE_SECONDS,
  callRequestSchema,
} from '@orderline/contracts/integration';
import { ApiError } from '../../platform/http/errors.js';
import { verifySignature } from '../../platform/security/signatures.js';
import type { createIntegrations } from './service.js';

export async function registerIntegrationRoutes(
  app: FastifyInstance,
  integrations: ReturnType<typeof createIntegrations>,
  inboundSecret: string,
) {
  // Encapsulated so only these routes receive the raw body the signature covers.
  await app.register(async (scope) => {
    scope.removeContentTypeParser('application/json');
    scope.addContentTypeParser(
      'application/json',
      { parseAs: 'string' },
      (_request, body, done) => done(null, body),
    );
    scope.post(
      '/integrations/v1/call-requests',
      { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } },
      async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        if (!inboundSecret)
          throw new ApiError(503, 'Business integration is not configured.');
        const body = typeof request.body === 'string' ? request.body : '';
        const signature = request.headers[SIGNATURE_HEADER];
        if (
          !verifySignature(
            inboundSecret,
            typeof signature === 'string' ? signature : undefined,
            body,
            SIGNATURE_TOLERANCE_SECONDS,
          )
        )
          throw new ApiError(401, 'Invalid request signature.');
        let json: unknown;
        try {
          json = JSON.parse(body);
        } catch {
          throw new ApiError(400, 'Request body must be valid JSON.');
        }
        const { receipt, created } = integrations.acceptCallRequest(
          callRequestSchema.parse(json),
        );
        return reply.code(created ? 202 : 200).send(receipt);
      },
    );
  });
}
