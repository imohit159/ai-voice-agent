import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ResultDeliverySummary } from '@orderline/contracts/api';
import { requireAdmin } from '../../platform/http/security.js';
import type { AuditRecorder } from '../audit/module.js';
import type { createResults } from './service.js';

const listQuery = z.object({
  status: z.enum(['pending', 'delivered', 'failed']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

/** Dashboard view of result delivery to the business system, and manual recovery. */
export function registerDeliveryRoutes(
  app: FastifyInstance,
  results: ReturnType<typeof createResults>,
  audit: AuditRecorder,
) {
  app.get(
    '/api/result-deliveries',
    async (request): Promise<{ deliveries: ResultDeliverySummary[] }> => {
      const { status, limit } = listQuery.parse(request.query);
      return { deliveries: results.list(status, limit) };
    },
  );
  app.post(
    '/api/result-deliveries/:eventId/retry',
    { preHandler: requireAdmin },
    async (request) => {
      const { eventId } = z.object({ eventId: z.uuid() }).parse(request.params);
      results.retryFailed(eventId);
      audit({
        userId: request.user!.id,
        action: 'delivery.retried',
        subjectType: 'result_delivery',
        subjectId: eventId,
      });
      return { queued: true };
    },
  );
}
