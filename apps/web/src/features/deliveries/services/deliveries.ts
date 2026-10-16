import type { ResultDeliverySummary } from '@orderline/contracts/api';
import { request } from '../../../shared/api/client.js';

export type DeliveryFilter = 'all' | ResultDeliverySummary['status'];

export const deliveriesService = {
  list: (filter: DeliveryFilter) =>
    request<{ deliveries: ResultDeliverySummary[] }>(
      `/api/result-deliveries${filter === 'all' ? '' : `?status=${filter}`}`,
    ),
  retry: (eventId: string) =>
    request<{ queued: true }>(
      `/api/result-deliveries/${encodeURIComponent(eventId)}/retry`,
      {
        method: 'POST',
        body: {},
      },
    ),
};
