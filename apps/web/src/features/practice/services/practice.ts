import type { PracticeAnswer, PracticeSession } from '@orderline/contracts/api';
import { request } from '../../../shared/api/client.js';

export const practiceService = {
  start: () =>
    request<PracticeSession>('/api/practice-sessions', {
      method: 'POST',
      body: {},
    }),
  offer: (attemptId: string, sdp: string) =>
    request<PracticeAnswer>(
      `/api/practice-sessions/${encodeURIComponent(attemptId)}/offer`,
      {
        method: 'POST',
        body: { sdp, type: 'offer' },
      },
    ),
};
