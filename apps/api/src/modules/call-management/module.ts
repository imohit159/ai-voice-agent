import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { config } from '../../config/index.js';
import { startIntervalJob } from '../../platform/jobs/interval-job.js';
import { createCallManagementRepository } from './repository.js';
import {
  createCallManagement,
  type AttemptFinishedEvent,
  type CallManagement,
} from './service.js';
import { createSimulatedTelephony } from './infrastructure/simulated-telephony.js';
import { createPlivoTelephony } from './infrastructure/plivo.js';
import { registerPlivoRoutes } from './plivo.routes.js';
import type { ProviderEvent, Telephony } from './telephony.js';

export type { AttemptFinishedEvent, CallManagement } from './service.js';
export { CallManagementError } from './service.js';
export type { StoredAttempt, StoredCallRequest } from './repository.js';
export { VOICE_SESSION_TOKEN_PURPOSE } from './plivo.routes.js';

const SCHEDULE_INTERVAL_MS = 5_000;
const RECONCILE_INTERVAL_MS = 60_000;

export function startCallManagement(
  app: FastifyInstance,
  db: DatabaseSync,
  options: {
    onAttemptFinished: (event: AttemptFinishedEvent) => void;
    aiConfig: () => Record<string, unknown>;
    /** Overrides the configured provider, for tests. */
    telephony?: (emit: (event: ProviderEvent) => void) => Telephony;
  },
): CallManagement {
  const configured = (emit: (event: ProviderEvent) => void): Telephony =>
    config.TELEPHONY_PROVIDER === 'plivo'
      ? createPlivoTelephony({
          authId: config.PLIVO_AUTH_ID,
          authToken: config.PLIVO_AUTH_TOKEN,
          fromNumber: config.PLIVO_FROM_NUMBER,
          publicBaseUrl: config.PUBLIC_BASE_URL,
          maxCallSeconds: config.MAX_CALL_SECONDS,
        })
      : createSimulatedTelephony(emit);
  // In-process providers report back through `emit`; Plivo reports through its callback routes.
  const telephony = (options.telephony ?? configured)((event) =>
    calls.applyProviderEvent(event),
  );
  const calls = createCallManagement({
    repository: createCallManagementRepository(db),
    telephony,
    policy: {
      startHour: config.CALLING_HOURS_START,
      endHour: config.CALLING_HOURS_END,
      retryDelaysMinutes: config.CALL_RETRY_DELAYS_MINUTES,
    },
    maxConcurrentCalls: config.MAX_CONCURRENT_CALLS,
    maxCallSeconds: config.MAX_CALL_SECONDS,
    aiConfig: options.aiConfig,
    onAttemptFinished: options.onAttemptFinished,
    now: () => new Date(),
    newId: randomUUID,
    log: app.log,
  });
  if (telephony.name === 'plivo')
    registerPlivoRoutes(app, calls, {
      authToken: config.PLIVO_AUTH_TOKEN,
      publicBaseUrl: config.PUBLIC_BASE_URL,
      streamUrl: config.VOICE_AGENT_STREAM_URL,
      sessionSecret: config.SESSION_SECRET,
      maxCallSeconds: config.MAX_CALL_SECONDS,
    });
  else
    app.log.warn(
      { provider: telephony.name },
      'Calls are not placed through a real telephony provider',
    );
  calls.recoverAfterRestart();
  const stopSchedule = startIntervalJob(
    'call-schedule',
    SCHEDULE_INTERVAL_MS,
    calls.runSchedule,
    app.log,
  );
  const stopReconcile = startIntervalJob(
    'call-reconciliation',
    RECONCILE_INTERVAL_MS,
    calls.reconcile,
    app.log,
  );
  app.addHook('onClose', async () => {
    await Promise.all([stopSchedule(), stopReconcile()]);
    telephony.close?.();
  });
  return calls;
}
