import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { config } from '../../config/index.js';
import { startIntervalJob } from '../../platform/jobs/interval-job.js';
import type { CallManagement } from '../call-management/module.js';
import { createResultDeliveryRepository } from './repository.js';
import { createResults } from './service.js';
import { postSignedJson } from './infrastructure/webhook.js';
import { registerIntegrationRoutes } from './routes.js';
import { registerDeliveryRoutes } from './delivery.routes.js';
import type { AuditRecorder } from '../audit/module.js';

const DELIVERY_INTERVAL_MS = 5_000;
// Roughly 1m, 5m, 15m, 1h, 3h, 6h: about 10.5 hours of retries before manual recovery.
const DELIVERY_RETRY_DELAYS_SECONDS = [60, 300, 900, 3_600, 10_800, 21_600];

export function startIntegrations(
  app: FastifyInstance,
  db: DatabaseSync,
  audit: AuditRecorder,
) {
  const { INTEGRATION_RESULT_URL: url, INTEGRATION_RESULT_SECRET: secret } =
    config;
  if (!url || !secret)
    app.log.warn(
      'INTEGRATION_RESULT_URL or INTEGRATION_RESULT_SECRET is not set; call results will wait in the outbox.',
    );
  const results = createResults({
    deliveries: createResultDeliveryRepository(db),
    send: url && secret ? (body) => postSignedJson(url, secret, body) : null,
    retryDelaysSeconds: DELIVERY_RETRY_DELAYS_SECONDS,
    now: () => new Date(),
    newId: randomUUID,
    log: app.log,
  });
  const stopDelivery = startIntervalJob(
    'result-delivery',
    DELIVERY_INTERVAL_MS,
    results.deliverDue,
    app.log,
  );
  app.addHook('onClose', stopDelivery);
  registerDeliveryRoutes(app, results, audit);
  return {
    recordAttemptResult: results.record,
    registerRoutes: (intake: Pick<CallManagement, 'acceptCallRequest'>) =>
      registerIntegrationRoutes(app, intake, config.INTEGRATION_INBOUND_SECRET),
  };
}
