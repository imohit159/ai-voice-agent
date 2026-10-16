import type {
  CallAttemptDetail,
  CallAttemptSummary,
} from '@orderline/contracts/api';
import { request } from '../../../shared/api/client.js';

export const callsService = {
  list: () => request<{ attempts: CallAttemptSummary[] }>('/api/call-attempts'),
  /** Viewing a customer transcript is recorded in the audit trail. */
  detail: (id: string) =>
    request<CallAttemptDetail>(`/api/call-attempts/${encodeURIComponent(id)}`),
};
