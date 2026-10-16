import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { config } from '../../config/index.js';
import { createCallRequestRepository } from './repository.js';
import { createIntegrations } from './service.js';
import { registerIntegrationRoutes } from './routes.js';

export async function registerIntegrationsModule(
  app: FastifyInstance,
  db: DatabaseSync,
) {
  const integrations = createIntegrations({
    requests: createCallRequestRepository(db),
    now: () => new Date(),
    newId: randomUUID,
    log: app.log,
  });
  await registerIntegrationRoutes(
    app,
    integrations,
    config.INTEGRATION_INBOUND_SECRET,
  );
}
