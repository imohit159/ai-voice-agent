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
import type { Telephony } from './telephony.js';

export type { AttemptFinishedEvent, CallManagement } from './service.js';
export { CallManagementError } from './service.js';
export type { StoredAttempt, StoredCallRequest } from './repository.js';

const SCHEDULE_INTERVAL_MS = 5_000;
const RECONCILE_INTERVAL_MS = 60_000;

export function startCallManagement(
  app: FastifyInstance,
  db: DatabaseSync,
  options: {
    onAttemptFinished: (event: AttemptFinishedEvent) => void;
    aiConfig: () => Record<string, unknown>;
    telephony?: (
      emit: Parameters<typeof createSimulatedTelephony>[0],
    ) => Telephony;
  },
): CallManagement {
  // Provider callbacks feed back into the service the adapter is constructed for.
  const telephony = (options.telephony ?? createSimulatedTelephony)((event) =>
    calls.applyProviderEvent(
      event.attemptId,
      event.providerCallId,
      event.status,
    ),
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
