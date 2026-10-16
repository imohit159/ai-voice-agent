import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge } from '../../../shared/ui/Badge.js';
import { dateTime } from '../../../shared/ui/format.js';
import { QueryState } from '../../../shared/ui/QueryState.js';
import { useToast } from '../../../shared/ui/Toast.js';
import {
  deliveriesService,
  type DeliveryFilter,
} from '../services/deliveries.js';

const FILTERS: [DeliveryFilter, string][] = [
  ['all', 'All'],
  ['failed', 'Failed'],
  ['pending', 'Pending'],
  ['delivered', 'Delivered'],
];

export function DeliveriesPage({ isAdmin }: { isAdmin: boolean }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<DeliveryFilter>('all');
  const deliveries = useQuery({
    queryKey: ['result-deliveries', filter],
    queryFn: () => deliveriesService.list(filter),
    refetchInterval: 10_000,
  });
  const retry = useMutation({
    mutationFn: deliveriesService.retry,
    onSuccess: () => {
      toast('Queued for one more delivery attempt.');
      void queryClient.invalidateQueries({ queryKey: ['result-deliveries'] });
    },
    onError: (error) => toast(error.message),
  });
  const rows = deliveries.data?.deliveries ?? [];
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">BUSINESS SYSTEM</span>
          <h1>Result delivery</h1>
          <p>
            Every call result sent to your business system. Failed deliveries
            stopped retrying automatically and need a decision.
          </p>
        </div>
      </div>
      <section className="panel">
        <div className="tabs" role="group" aria-label="Delivery status">
          {FILTERS.map(([value, text]) => (
            <button
              key={value}
              className={filter === value ? 'active' : ''}
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {text}
            </button>
          ))}
        </div>
        <QueryState
          isPending={deliveries.isPending}
          error={deliveries.error}
          onRetry={() => void deliveries.refetch()}
          isEmpty={rows.length === 0}
          empty={<p className="empty-small">No results in this view.</p>}
        >
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Created</th>
                  <th>Request</th>
                  <th>Delivery</th>
                  <th>Tries</th>
                  <th>Last error</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((delivery) => (
                  <tr key={delivery.eventId}>
                    <td>{dateTime(delivery.createdAt)}</td>
                    <td>
                      <strong>{delivery.requestId}</strong>
                      <small>
                        <Badge value={delivery.requestStatus} />
                      </small>
                    </td>
                    <td>
                      <Badge value={delivery.status} />
                      {delivery.deliveredAt && (
                        <small>{dateTime(delivery.deliveredAt)}</small>
                      )}
                    </td>
                    <td>{delivery.deliveryAttempts}</td>
                    <td className="muted">{delivery.lastError ?? '—'}</td>
                    <td>
                      {isAdmin && delivery.status === 'failed' && (
                        <button
                          className="text-button"
                          disabled={retry.isPending}
                          onClick={() => retry.mutate(delivery.eventId)}
                        >
                          Retry now
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </QueryState>
      </section>
    </>
  );
}
