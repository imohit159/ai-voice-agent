import type { Settings } from '@orderline/contracts';
import type { WorkspaceState } from '@orderline/contracts/api';
import { request } from '../../../shared/api/client.js';

export const settingsService = {
  state: () => request<WorkspaceState>('/api/state'),
  save: (settings: Settings) =>
    request<{ settings: Settings }>('/api/settings', {
      method: 'PUT',
      body: settings,
    }),
};
