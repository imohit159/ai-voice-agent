import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { CallRequest } from '@orderline/contracts/integration';
import type { AgentConfig } from '@orderline/contracts/voice';
import { config } from '../../config/index.js';
import { startIntervalJob } from '../../platform/jobs/interval-job.js';
import { issueToken, verifyToken } from '../../platform/security/tokens.js';
import { createCallManagementRepository } from './repository.js';
import {
  createCallManagement,
  type AttemptFinishedEvent,
  type CallManagement,
} from './service.js';
import { createVoiceSessions } from './voice-session.service.js';
import { createSimulatedTelephony } from './infrastructure/simulated-telephony.js';
import { createPlivoTelephony } from './infrastructure/plivo.js';
import {
  createVoiceAgentClient,
  type VoiceAgentClient,
  type VoiceAgentStatus,
} from './infrastructure/voice-agent.js';
import {
  registerPlivoRoutes,
  VOICE_SESSION_TOKEN_PURPOSE,
} from './plivo.routes.js';
import { registerVoiceSessionRoutes } from './voice-session.routes.js';
import { registerOperatorRoutes } from './operator.routes.js';
import type { ProviderEvent, Telephony } from './telephony.js';
import type { AuditRecorder } from '../audit/module.js';

export type { AttemptFinishedEvent, CallManagement } from './service.js';
export { CallManagementError } from './service.js';
export type { StoredAttempt, StoredCallRequest } from './repository.js';
export { VOICE_SESSION_TOKEN_PURPOSE } from './plivo.routes.js';

const SCHEDULE_INTERVAL_MS = 5_000;
const RECONCILE_INTERVAL_MS = 60_000;
const PRACTICE_EXPIRY_INTERVAL_MS = 30_000;
// Covers the call plus teardown, matching the token issued on Plivo answer.
const SESSION_TOKEN_GRACE_SECONDS = 120;
const VOICE_AGENT_STATUS_CACHE_MS = 15_000;

export async function startCallManagement(
  app: FastifyInstance,
  db: DatabaseSync,
  options: {
    onAttemptFinished: (event: AttemptFinishedEvent) => void;
    agentConfig: () => AgentConfig;
    practiceOrder: () => Pick<CallRequest, 'customer' | 'order'>;
    audit: AuditRecorder;
    /** Overrides the configured provider, for tests. */
    telephony?: (emit: (event: ProviderEvent) => void) => Telephony;
    /** Overrides the voice agent client, for tests. */
    voiceAgent?: VoiceAgentClient;
  },
): Promise<{
  calls: CallManagement;
  voiceAgentStatus: () => Promise<VoiceAgentStatus | null>;
}> {
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
  const voiceAgent =
    options.voiceAgent ??
    createVoiceAgentClient({
      baseUrl: config.VOICE_AGENT_INTERNAL_URL,
      token: config.VOICE_AGENT_INTERNAL_TOKEN,
    });
  let cachedStatus: { at: number; status: VoiceAgentStatus | null } | null =
    null;
  const voiceAgentStatus = async () => {
    if (
      !cachedStatus ||
      Date.now() - cachedStatus.at > VOICE_AGENT_STATUS_CACHE_MS
    )
      cachedStatus = { at: Date.now(), status: await voiceAgent.status() };
    return cachedStatus.status;
  };
  const repository = createCallManagementRepository(db);
  const calls = createCallManagement({
    repository,
    telephony,
    policy: {
      startHour: config.CALLING_HOURS_START,
      endHour: config.CALLING_HOURS_END,
      retryDelaysMinutes: config.CALL_RETRY_DELAYS_MINUTES,
    },
    maxConcurrentCalls: config.MAX_CONCURRENT_CALLS,
    maxCallSeconds: config.MAX_CALL_SECONDS,
    agentConfig: options.agentConfig,
    isVoiceAgentReady: async (agent) =>
      (await voiceAgentStatus())?.providers[agent.voiceProvider] === true,
    onAttemptFinished: options.onAttemptFinished,
    now: () => new Date(),
    newId: randomUUID,
    log: app.log,
  });
  const sessions = createVoiceSessions({
    repository,
    calls,
    verifySessionToken: (token) =>
      verifyToken(config.SESSION_SECRET, token, VOICE_SESSION_TOKEN_PURPOSE),
    maxCallSeconds: config.MAX_CALL_SECONDS,
    now: () => new Date(),
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
  await registerVoiceSessionRoutes(
    app,
    sessions,
    config.VOICE_AGENT_INTERNAL_TOKEN,
  );
  registerOperatorRoutes(app, calls, {
    practiceOrder: options.practiceOrder,
    issueSessionToken: (attemptId) =>
      issueToken(
        config.SESSION_SECRET,
        VOICE_SESSION_TOKEN_PURPOSE,
        attemptId,
        config.MAX_CALL_SECONDS + SESSION_TOKEN_GRACE_SECONDS,
      ),
    voiceAgent,
    audit: options.audit,
  });

  calls.recoverAfterRestart();
  const stops = [
    startIntervalJob(
      'call-schedule',
      SCHEDULE_INTERVAL_MS,
      calls.runSchedule,
      app.log,
    ),
    startIntervalJob(
      'call-reconciliation',
      RECONCILE_INTERVAL_MS,
      calls.reconcile,
      app.log,
    ),
    startIntervalJob(
      'practice-expiry',
      PRACTICE_EXPIRY_INTERVAL_MS,
      calls.expirePracticeSessions,
      app.log,
    ),
  ];
  app.addHook('onClose', async () => {
    await Promise.all(stops.map((stop) => stop()));
    telephony.close?.();
  });
  return { calls, voiceAgentStatus };
}
