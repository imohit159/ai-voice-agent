import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { requireAdmin } from '../../platform/http/security.js';
import { createAuditRepository } from './repository.js';
import { createAudit } from './service.js';

export type { AuditRecorder } from './service.js';
export type { NewAuditEvent } from './repository.js';

export function startAudit(app: FastifyInstance, db: DatabaseSync) {
  const audit = createAudit({
    repository: createAuditRepository(db),
    now: () => new Date(),
  });
  app.get(
    '/api/audit-events',
    { preHandler: requireAdmin },
    async (request) => {
      const { limit } = z
        .object({ limit: z.coerce.number().int().min(1).max(500).default(200) })
        .parse(request.query);
      return { events: audit.recent(limit) };
    },
  );
  return audit;
}
