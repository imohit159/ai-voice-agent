import { useQuery } from '@tanstack/react-query';
import { Badge } from '../../../shared/ui/Badge.js';
import { dateTime } from '../../../shared/ui/format.js';
import { QueryState } from '../../../shared/ui/QueryState.js';
import { callsService } from '../services/calls.js';
import { Transcript } from './Transcript.js';

export function CallDetail({
  id,
  onClose,
}: {
  id: string;
  onClose: () => void;
}) {
  const detail = useQuery({
    queryKey: ['call-attempt', id],
    queryFn: () => callsService.detail(id),
  });
  const attempt = detail.data?.attempt;
  const transcript = detail.data?.transcript ?? [];
  return (
    <section className="panel call-detail" aria-label="Conversation details">
      <div className="panel-heading">
        <h2>Conversation details</h2>
        <button className="text-button" onClick={onClose}>
          Close ✕
        </button>
      </div>
      <QueryState
        isPending={detail.isPending}
        error={detail.error}
        onRetry={() => void detail.refetch()}
      >
        {attempt && (
          <div className="detail-body">
            <p>
              <Badge value={attempt.status} />{' '}
              {attempt.outcome && <Badge value={attempt.outcome} />}
            </p>
            <p className="muted">
              {attempt.source === 'practice'
                ? 'Voice practice'
                : `Order ${attempt.orderRef}`}{' '}
              · attempt #{attempt.attemptNumber} · {dateTime(attempt.startedAt)}
              {attempt.agent &&
                ` · ${attempt.agent.voiceProvider} ${attempt.agent.model}`}
            </p>
            {attempt.outcomeSummary && (
              <blockquote>{attempt.outcomeSummary}</blockquote>
            )}
            {attempt.callbackAt && (
              <p>Call back requested for {dateTime(attempt.callbackAt)}</p>
            )}
            {attempt.failureReason && (
              <p className="error-note">{attempt.failureReason}</p>
            )}
            <div className="transcript-history">
              <Transcript entries={transcript} />
            </div>
          </div>
        )}
      </QueryState>
    </section>
  );
}
