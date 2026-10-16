import type { DatabaseSync } from 'node:sqlite';
import {
  OPEN_CALL_REQUEST_STATUSES,
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
  payload: CallRequest;
  payloadHash: string;
  createdAt: string;
  updatedAt: string;
}

type Row = {
  id: string;
  request_id: string;
  source: StoredCallRequest['source'];
  use_case: UseCase;
  order_ref: string;
  status: CallRequestStatus;
  max_attempts: number;
  not_before: string;
  not_after: string;
  payload: string;
  payload_hash: string;
  created_at: string;
  updated_at: string;
};

const toRecord = (row: Row): StoredCallRequest => ({
  id: row.id,
  requestId: row.request_id,
  source: row.source,
  useCase: row.use_case,
  orderRef: row.order_ref,
  status: row.status,
  maxAttempts: row.max_attempts,
  notBefore: row.not_before,
  notAfter: row.not_after,
  payload: JSON.parse(row.payload) as CallRequest,
  payloadHash: row.payload_hash,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export function createCallRequestRepository(db: DatabaseSync) {
  const openStatuses = OPEN_CALL_REQUEST_STATUSES.map(() => '?').join(',');
  return {
    findByRequestId(requestId: string): StoredCallRequest | null {
      const row = db
        .prepare('SELECT * FROM call_requests WHERE request_id=?')
        .get(requestId) as Row | undefined;
      return row ? toRecord(row) : null;
    },
    hasOpenRequest(useCase: UseCase, orderRef: string): boolean {
      return Boolean(
        db
          .prepare(
            `SELECT 1 FROM call_requests WHERE use_case=? AND order_ref=? AND status IN (${openStatuses}) LIMIT 1`,
          )
          .get(useCase, orderRef, ...OPEN_CALL_REQUEST_STATUSES),
      );
    },
    insert(record: StoredCallRequest): void {
      db.prepare(
        `INSERT INTO call_requests (id, request_id, source, use_case, order_ref, status, max_attempts,
          not_before, not_after, payload, payload_hash, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
        JSON.stringify(record.payload),
        record.payloadHash,
        record.createdAt,
        record.updatedAt,
      );
    },
  };
}

export type CallRequestRepository = ReturnType<
  typeof createCallRequestRepository
>;
