import { useQuery } from '@tanstack/react-query';
import type { CallAttemptSummary } from '@orderline/contracts/api';
import { Badge } from '../../../shared/ui/Badge.js';
import { dateTime } from '../../../shared/ui/format.js';
import { QueryState } from '../../../shared/ui/QueryState.js';
import { callsService } from '../services/calls.js';
import { CallDetail } from './CallDetail.js';

const REFRESH_MS = 10_000;

const channel = (attempt: CallAttemptSummary) =>
  attempt.source === 'practice' ? 'Voice practice' : 'Phone';

export function CallsPage({
  selectedId,
  select,
}: {
  selectedId: string | null;
  select: (id: string | null) => void;
}) {
  const attempts = useQuery({
    queryKey: ['call-attempts'],
    queryFn: callsService.list,
    refetchInterval: REFRESH_MS,
  });
  const rows = attempts.data?.attempts ?? [];
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">CONVERSATION HISTORY</span>
          <h1>Call activity</h1>
          <p>
            Every call attempt and practice session, its outcome and what was
            said.
          </p>
        </div>
        <button className="secondary" onClick={() => void attempts.refetch()}>
          ↻ Refresh
        </button>
      </div>
      <section className="panel">
        <div className="panel-heading">
          <h2>Recent attempts</h2>
          <span className="count-label">{rows.length}</span>
        </div>
        <QueryState
          isPending={attempts.isPending}
          error={attempts.error}
          onRetry={() => void attempts.refetch()}
          isEmpty={rows.length === 0}
          empty={
            <div className="empty-state">
              <span className="empty-symbol">◷</span>
              <h3>No conversations yet.</h3>
              <p>
                Start a voice practice, or send a call request from your
                business system.
              </p>
            </div>
          }
        >
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Started</th>
                  <th>Channel</th>
                  <th>Call</th>
                  <th>Outcome</th>
                  <th>Request</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((attempt) => (
                  <tr
                    key={attempt.id}
                    aria-selected={attempt.id === selectedId}
                  >
                    <td>
                      <strong>{dateTime(attempt.startedAt)}</strong>
                      <small>
                        {attempt.source === 'practice'
                          ? 'Practice'
                          : attempt.orderRef}
                      </small>
                    </td>
                    <td>
                      {channel(attempt)}
                      <small>{attempt.agent?.voiceProvider}</small>
                    </td>
                    <td>
                      <Badge value={attempt.status} />
                      <small>#{attempt.attemptNumber}</small>
                    </td>
                    <td>
                      {attempt.outcome ? (
                        <Badge value={attempt.outcome} />
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td>
                      <Badge value={attempt.requestStatus} />
                    </td>
                    <td>
                      <button
                        className="text-button"
                        onClick={() => select(attempt.id)}
                      >
                        View ↗
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </QueryState>
      </section>
      {selectedId && (
        <CallDetail id={selectedId} onClose={() => select(null)} />
      )}
    </>
  );
}
