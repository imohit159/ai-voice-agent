import type {
  TranscriptBatch,
  VoiceSessionClaim,
  VoiceSessionContext,
  VoiceSessionEnd,
} from '@orderline/contracts/voice';
import type { CallManagementRepository, StoredAttempt } from './repository.js';
import { CallManagementError, type CallManagement } from './service.js';

type LogEvent = (fields: Record<string, unknown>, message: string) => void;
type Dependencies = {
  repository: CallManagementRepository;
  calls: Pick<CallManagement, 'finishPracticeSession'>;
  /** Returns the attempt ID a voice-session token was issued for, or null. */
  verifySessionToken: (token: string) => string | null;
  maxCallSeconds: number;
  now: () => Date;
  log: { info: LogEvent; warn: LogEvent };
};

// Bounds a runaway or looping session's transcript well above any real call.
const MAX_TRANSCRIPT_ENTRIES = 2_000;

export function createVoiceSessions({
  repository,
  calls,
  verifySessionToken,
  maxCallSeconds,
  now,
  log,
}: Dependencies) {
  /** Every call must carry the token issued for this attempt. */
  function authorize(attemptId: string, token: string): StoredAttempt {
    const attempt = repository.attemptById(attemptId);
    if (!attempt || verifySessionToken(token) !== attemptId)
      throw new CallManagementError(403, 'Voice session is not authorized.');
    return attempt;
  }

  /**
   * Binds the voice agent to one answered attempt, once. A replayed stream,
   * a stream for another call, or a second agent for the same call is refused.
   */
  function claim(input: VoiceSessionClaim): VoiceSessionContext {
    const attempt = authorize(input.attemptId, input.sessionToken);
    const request = repository.requestById(attempt.callRequestId)!;
    const isPractice = request.source === 'practice';
    const expected =
      input.transport === 'webrtc'
        ? isPractice
        : !isPractice &&
          attempt.provider === 'plivo' &&
          Boolean(input.providerLegId) &&
          attempt.providerLegId === input.providerLegId;
    if (!expected)
      throw new CallManagementError(
        403,
        'Voice session does not match the call.',
      );
    if (!attempt.agentConfig)
      throw new CallManagementError(409, 'Call has no agent configuration.');
    if (!repository.claimVoiceSession(attempt.id, now().toISOString()))
      throw new CallManagementError(
        409,
        'Voice session already started or the call is not active.',
      );
    log.info(
      { attemptId: attempt.id, transport: input.transport },
      'Voice session started',
    );
    return {
      attemptId: attempt.id,
      transport: input.transport,
      isPractice,
      maxCallSeconds,
      agent: attempt.agentConfig,
      customer: { name: request.payload.customer.name },
      order: request.payload.order,
    };
  }

  function appendTranscript(attemptId: string, batch: TranscriptBatch) {
    const attempt = authorize(attemptId, batch.sessionToken);
    if (!attempt.voiceSessionStartedAt || attempt.voiceSessionEndedAt)
      throw new CallManagementError(409, 'Voice session is not active.');
    if (
      repository.transcriptCount(attempt.id) + batch.entries.length >
      MAX_TRANSCRIPT_ENTRIES
    )
      throw new CallManagementError(413, 'Transcript limit reached.');
    repository.insertTranscript(attempt.id, batch.entries, now().toISOString());
  }

  /** Idempotent. Phone attempts finish from Plivo's hangup callback; practice finishes here. */
  function end(attemptId: string, body: VoiceSessionEnd) {
    const attempt = authorize(attemptId, body.sessionToken);
    repository.endVoiceSession(attempt.id, now().toISOString());
    const request = repository.requestById(attempt.callRequestId)!;
    if (request.source === 'practice')
      calls.finishPracticeSession(
        attempt.id,
        body.reason === 'error' ? 'failed' : 'completed',
        body.reason === 'error' ? 'The voice agent reported an error.' : null,
      );
    log.info(
      { attemptId: attempt.id, reason: body.reason },
      'Voice session ended',
    );
  }

  return { claim, appendTranscript, end };
}

export type VoiceSessions = ReturnType<typeof createVoiceSessions>;
