import type { DatabaseSync } from 'node:sqlite';
import type { CallResult } from '@orderline/contracts/integration';
import type { ResultDeliverySummary } from '@orderline/contracts/api';

export interface ResultDelivery {
  eventId: string;
  callRequestId: string;
  attemptId: string | null;
  payload: CallResult;
  status: 'pending' | 'delivered' | 'failed';
  deliveryAttempts: number;
  nextAttemptAt: string;
  lastError: string | null;
  deliveredAt: string | null;
  createdAt: string;
}

type Row = {
  event_id: string;
  call_request_id: string;
  attempt_id: string | null;
  payload: string;
  status: ResultDelivery['status'];
  delivery_attempts: number;
  next_attempt_at: string;
  last_error: string | null;
  delivered_at: string | null;
  created_at: string;
};

const toDelivery = (row: Row): ResultDelivery => ({
  eventId: row.event_id,
  callRequestId: row.call_request_id,
  attemptId: row.attempt_id,
  payload: JSON.parse(row.payload) as CallResult,
  status: row.status,
  deliveryAttempts: row.delivery_attempts,
  nextAttemptAt: row.next_attempt_at,
  lastError: row.last_error,
  deliveredAt: row.delivered_at,
  createdAt: row.created_at,
});

export function createResultDeliveryRepository(db: DatabaseSync) {
  return {
    insert(
      delivery: Pick<
        ResultDelivery,
        'eventId' | 'callRequestId' | 'attemptId' | 'payload' | 'createdAt'
      >,
    ): void {
      db.prepare(
        `INSERT INTO result_deliveries (event_id, call_request_id, attempt_id, payload, status,
          next_attempt_at, created_at) VALUES (?,?,?,?,'pending',?,?)`,
      ).run(
        delivery.eventId,
        delivery.callRequestId,
        delivery.attemptId,
        JSON.stringify(delivery.payload),
        delivery.createdAt,
        delivery.createdAt,
      );
    },
    due(at: string, limit: number): ResultDelivery[] {
      return (
        db
          .prepare(
            `SELECT * FROM result_deliveries WHERE status='pending' AND next_attempt_at <= ?
              ORDER BY next_attempt_at LIMIT ?`,
          )
          .all(at, limit) as Row[]
      ).map(toDelivery);
    },
    byEventId(eventId: string): ResultDelivery | null {
      const row = db
        .prepare('SELECT * FROM result_deliveries WHERE event_id=?')
        .get(eventId) as Row | undefined;
      return row ? toDelivery(row) : null;
    },
    summaries(
      status: ResultDelivery['status'] | undefined,
      limit: number,
    ): ResultDeliverySummary[] {
      const rows = db
        .prepare(
          `SELECT * FROM result_deliveries ${status ? 'WHERE status = ?' : ''}
            ORDER BY created_at DESC LIMIT ?`,
        )
        .all(...(status ? [status] : []), limit) as Row[];
      return rows.map(toDelivery).map((delivery) => ({
        eventId: delivery.eventId,
        requestId: delivery.payload.requestId,
        attemptId: delivery.attemptId,
        requestStatus: delivery.payload.requestStatus,
        status: delivery.status,
        deliveryAttempts: delivery.deliveryAttempts,
        lastError: delivery.lastError,
        nextAttemptAt: delivery.nextAttemptAt,
        deliveredAt: delivery.deliveredAt,
        createdAt: delivery.createdAt,
      }));
    },
    /** Puts a failed delivery back in the queue; false if it is not failed. */
    requeueFailed(eventId: string, at: string): boolean {
      return (
        db
          .prepare(
            `UPDATE result_deliveries SET status='pending', next_attempt_at=?
              WHERE event_id=? AND status='failed'`,
          )
          .run(at, eventId).changes === 1
      );
    },
    recordAttempt(
      eventId: string,
      change: Pick<
        ResultDelivery,
        'status' | 'nextAttemptAt' | 'lastError' | 'deliveredAt'
      >,
    ): void {
      db.prepare(
        `UPDATE result_deliveries SET status=?, next_attempt_at=?, last_error=?, delivered_at=?,
          delivery_attempts = delivery_attempts + 1 WHERE event_id=?`,
      ).run(
        change.status,
        change.nextAttemptAt,
        change.lastError,
        change.deliveredAt,
        eventId,
      );
    },
  };
}

export type ResultDeliveryRepository = ReturnType<
  typeof createResultDeliveryRepository
>;
