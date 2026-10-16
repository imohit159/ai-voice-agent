import type { DatabaseSync } from 'node:sqlite';
import type { AuditAction } from '@orderline/contracts';
import type { AuditEventSummary } from '@orderline/contracts/api';

export interface NewAuditEvent {
  userId: string | null;
  action: AuditAction;
  subjectType?: string;
  subjectId?: string;
}

export function createAuditRepository(db: DatabaseSync) {
  return {
    insert(event: NewAuditEvent, createdAt: string): void {
      db.prepare(
        `INSERT INTO audit_events (user_id, action, subject_type, subject_id, created_at)
          VALUES (?,?,?,?,?)`,
      ).run(
        event.userId,
        event.action,
        event.subjectType ?? null,
        event.subjectId ?? null,
        createdAt,
      );
    },
    recent(limit: number): AuditEventSummary[] {
      return db
        .prepare(
          `SELECT e.id, e.action, u.email AS userEmail, e.subject_type AS subjectType,
            e.subject_id AS subjectId, e.created_at AS createdAt
            FROM audit_events e LEFT JOIN users u ON u.id = e.user_id
            ORDER BY e.id DESC LIMIT ?`,
        )
        .all(limit) as unknown as AuditEventSummary[];
    },
  };
}
