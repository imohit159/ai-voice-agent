import type { SessionInfo } from '@orderline/contracts/api';
import { request } from '../../../shared/api/client.js';

export const authService = {
  session: () => request<SessionInfo>('/api/session'),
  login: (email: string, password: string) =>
    request<SessionInfo>('/api/login', {
      method: 'POST',
      body: { email, password },
    }),
  logout: () =>
    request<SessionInfo>('/api/logout', { method: 'POST', body: {} }),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ changed: true }>('/api/me/password', {
      method: 'POST',
      body: { currentPassword, newPassword },
    }),
};
