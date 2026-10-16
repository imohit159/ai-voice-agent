import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import {
  LIVE_ATTEMPT_STATUSES,
  OPEN_CALL_REQUEST_STATUSES,
  type AttemptStatus,
  type CallOutcome,
  type CallRequest,
  type CallRequestStatus,
  type UseCase,
} from '@orderline/contracts/integration';

export interface StoredCallRequest {
  id: string;
  requestId: string;
  source: 'integration' | 'practice';
  useCase: UseCase;
  orderRef: string;
  status: CallRequestStatus;
  maxAttempts: number;
  notBefore: string;
  notAfter: string;
  nextAttemptAt: string | null;
  payload: CallRequest;
  payloadHash: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoredAttempt {
  id: string;
  callRequestId: string;
  attemptNumber: number;
  status: AttemptStatus;
  provider: string;
  providerCallId: string | null;
  aiConfig: Record<string, unknown>;
  outcome: CallOutcome | null;
  outcomeSummary: string | null;
  callbackAt: string | null;
  failureReason: string | null;
  startedAt: string;
  answeredAt: string | null;
  endedAt: string | null;
}

type RequestRow = {
  id: string;
  request_id: string;
  source: StoredCallRequest['source'];
  use_case: UseCase;
  order_ref: string;
  status: CallRequestStatus;
  max_attempts: number;
  not_before: string;
  not_after: string;
  next_attempt_at: string | null;
  payload: string;
  payload_hash: string;
  created_at: string;
  updated_at: string;
};

type AttemptRow = {
  id: string;
  call_request_id: string;
  attempt_number: number;
  status: AttemptStatus;
  provider: string;
  provider_call_id: string | null;
  ai_config: string;
  outcome: CallOutcome | null;
  outcome_summary: string | null;
  callback_at: string | null;
  failure_reason: string | null;
  started_at: string;
  answered_at: string | null;
  ended_at: string | null;
};

const toRequest = (row: RequestRow): StoredCallRequest => ({
  id: row.id,
  requestId: row.request_id,
  source: row.source,
  useCase: row.use_case,
  orderRef: row.order_ref,
  status: row.status,
  maxAttempts: row.max_attempts,
  notBefore: row.not_before,
  notAfter: row.not_after,
  nextAttemptAt: row.next_attempt_at,
  payload: JSON.parse(row.payload) as CallRequest,
  payloadHash: row.payload_hash,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const toAttempt = (row: AttemptRow): StoredAttempt => ({
  id: row.id,
  callRequestId: row.call_request_id,
  attemptNumber: row.attempt_number,
  status: row.status,
  provider: row.provider,
  providerCallId: row.provider_call_id,
  aiConfig: JSON.parse(row.ai_config) as Record<string, unknown>,
  outcome: row.outcome,
  outcomeSummary: row.outcome_summary,
  callbackAt: row.callback_at,
  failureReason: row.failure_reason,
  startedAt: row.started_at,
  answeredAt: row.answered_at,
  endedAt: row.ended_at,
});

const placeholders = (values: readonly unknown[]) =>
  values.map(() => '?').join(',');

export function createCallManagementRepository(db: DatabaseSync) {
  const requestById = (id: string) => {
    const row = db.prepare('SELECT * FROM call_requests WHERE id=?').get(id) as
      RequestRow | undefined;
    return row ? toRequest(row) : null;
  };
  const attemptById = (id: string) => {
    const row = db.prepare('SELECT * FROM call_attempts WHERE id=?').get(id) as
      AttemptRow | undefined;
    return row ? toAttempt(row) : null;
  };
  const requests = (sql: string, ...params: SQLInputValue[]) =>
    (db.prepare(sql).all(...params) as RequestRow[]).map(toRequest);
  const attempts = (sql: string, ...params: SQLInputValue[]) =>
    (db.prepare(sql).all(...params) as AttemptRow[]).map(toAttempt);

  return {
    /** Runs `work` atomically. Not re-entrant: never call from inside another transaction. */
    transaction<T>(work: () => T): T {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = work();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },

    requestById,
    requestByRequestId(requestId: string): StoredCallRequest | null {
      const row = db
        .prepare('SELECT * FROM call_requests WHERE request_id=?')
        .get(requestId) as RequestRow | undefined;
      return row ? toRequest(row) : null;
    },
    hasOpenRequest(useCase: UseCase, orderRef: string): boolean {
      return Boolean(
        db
          .prepare(
            `SELECT 1 FROM call_requests WHERE use_case=? AND order_ref=?
              AND status IN (${placeholders(OPEN_CALL_REQUEST_STATUSES)}) LIMIT 1`,
          )
          .get(useCase, orderRef, ...OPEN_CALL_REQUEST_STATUSES),
      );
    },
    insertRequest(record: StoredCallRequest): void {
      db.prepare(
        `INSERT INTO call_requests (id, request_id, source, use_case, order_ref, status, max_attempts,
          not_before, not_after, next_attempt_at, payload, payload_hash, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        record.id,
        record.requestId,
        record.source,
        record.useCase,
        record.orderRef,
        record.status,
        record.maxAttempts,
        record.notBefore,
        record.notAfter,
        record.nextAttemptAt,
        JSON.stringify(record.payload),
        record.payloadHash,
        record.createdAt,
        record.updatedAt,
      );
    },
    updateRequest(
      id: string,
      change: Pick<StoredCallRequest, 'status' | 'nextAttemptAt' | 'updatedAt'>,
    ): StoredCallRequest {
      db.prepare(
        'UPDATE call_requests SET status=?, next_attempt_at=?, updated_at=? WHERE id=?',
      ).run(change.status, change.nextAttemptAt, change.updatedAt, id);
      return requestById(id)!;
    },
    /** Integration requests whose next attempt is due and whose window is still open. */
    dueRequests(at: string, limit: number): StoredCallRequest[] {
      return requests(
        `SELECT * FROM call_requests WHERE status='pending' AND source='integration'
          AND next_attempt_at <= ? AND not_after > ? ORDER BY next_attempt_at LIMIT ?`,
        at,
        at,
        limit,
      );
    },
    overdueRequests(at: string): StoredCallRequest[] {
      return requests(
        "SELECT * FROM call_requests WHERE status='pending' AND not_after <= ?",
        at,
      );
    },

    attemptById,
    attemptCount(callRequestId: string): number {
      const row = db
        .prepare(
          'SELECT count(*) AS n FROM call_attempts WHERE call_request_id=?',
        )
        .get(callRequestId) as { n: number };
      return row.n;
    },
    insertAttempt(attempt: StoredAttempt): void {
      db.prepare(
        `INSERT INTO call_attempts (id, call_request_id, attempt_number, status, provider,
          provider_call_id, ai_config, started_at) VALUES (?,?,?,?,?,?,?,?)`,
      ).run(
        attempt.id,
        attempt.callRequestId,
        attempt.attemptNumber,
        attempt.status,
        attempt.provider,
        attempt.providerCallId,
        JSON.stringify(attempt.aiConfig),
        attempt.startedAt,
      );
    },
    updateAttempt(
      id: string,
      change: Pick<
        StoredAttempt,
        'status' | 'providerCallId' | 'failureReason' | 'answeredAt' | 'endedAt'
      >,
    ): StoredAttempt {
      db.prepare(
        `UPDATE call_attempts SET status=?, provider_call_id=?, failure_reason=?,
          answered_at=?, ended_at=? WHERE id=?`,
      ).run(
        change.status,
        change.providerCallId,
        change.failureReason,
        change.answeredAt,
        change.endedAt,
        id,
      );
      return attemptById(id)!;
    },
    /** Live attempts started after `since`; older ones cannot still hold a call slot. */
    liveAttemptCount(since: string): number {
      const row = db
        .prepare(
          `SELECT count(*) AS n FROM call_attempts
            WHERE status IN (${placeholders(LIVE_ATTEMPT_STATUSES)}) AND started_at > ?`,
        )
        .get(...LIVE_ATTEMPT_STATUSES, since) as { n: number };
      return row.n;
    },
    attemptsWithStatus(status: AttemptStatus): StoredAttempt[] {
      return attempts('SELECT * FROM call_attempts WHERE status=?', status);
    },
    /** Attempts whose provider state is uncertain or overdue and can be looked up. */
    attemptsToReconcile(staleBefore: string): StoredAttempt[] {
      return attempts(
        `SELECT * FROM call_attempts WHERE provider_call_id IS NOT NULL AND (status='unknown'
          OR (status IN ('dialing','ringing','in_progress') AND started_at <= ?))`,
        staleBefore,
      );
    },
  };
}

export type CallManagementRepository = ReturnType<
  typeof createCallManagementRepository
>;
