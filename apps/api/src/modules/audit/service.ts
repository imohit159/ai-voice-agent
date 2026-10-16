import type { createAuditRepository, NewAuditEvent } from './repository.js';

export type AuditRecorder = (event: NewAuditEvent) => void;

export function createAudit({
  repository,
  now,
}: {
  repository: ReturnType<typeof createAuditRepository>;
  now: () => Date;
}) {
  return {
    /** Append-only: the trail is never edited or deleted by the application. */
    record: ((event) =>
      repository.insert(event, now().toISOString())) as AuditRecorder,
    recent: (limit: number) => repository.recent(limit),
  };
}
