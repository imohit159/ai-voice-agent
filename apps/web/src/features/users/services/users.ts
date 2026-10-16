import type { UserRole } from '@orderline/contracts';
import type { AuditEventSummary, UserSummary } from '@orderline/contracts/api';
import { request } from '../../../shared/api/client.js';

export const usersService = {
  list: () => request<{ users: UserSummary[] }>('/api/users'),
  create: (input: {
    email: string;
    name: string;
    role: UserRole;
    password: string;
  }) =>
    request<{ user: UserSummary }>('/api/users', {
      method: 'POST',
      body: input,
    }),
  update: (id: string, change: { role?: UserRole; disabled?: boolean }) =>
    request<{ user: UserSummary }>(`/api/users/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: change,
    }),
  resetPassword: (id: string, password: string) =>
    request<{ reset: true }>(`/api/users/${encodeURIComponent(id)}/password`, {
      method: 'POST',
      body: { password },
    }),
  audit: () => request<{ events: AuditEventSummary[] }>('/api/audit-events'),
};
