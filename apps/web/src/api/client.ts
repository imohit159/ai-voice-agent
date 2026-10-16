import type { Settings, Order } from '@orderline/contracts';
import type {
  CallAttemptDetail,
  CallAttemptSummary,
  PracticeAnswer,
  PracticeSession,
  WorkspaceState,
} from '@orderline/contracts/api';

export function createApiClient(onUnauthorized: () => void) {
  async function request<T>(
    path: string,
    method = 'GET',
    data?: unknown,
  ): Promise<T> {
    const response = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    const body = await response.json();
    if (!response.ok) {
      if (response.status === 401 && path !== '/api/login') onUnauthorized();
      throw new Error(body.error || 'Request failed.');
    }
    return body as T;
  }

  return {
    session: () => request<{ authenticated: boolean }>('/api/session'),
    login: (password: string) =>
      request<{ authenticated: boolean }>('/api/login', 'POST', { password }),
    logout: () =>
      request<{ authenticated: boolean }>('/api/logout', 'POST', {}),
    state: () => request<WorkspaceState>('/api/state'),
    saveSettings: (settings: Settings | Record<string, FormDataEntryValue>) =>
      request<{ settings: Settings }>('/api/settings', 'PUT', settings),
    resetDemo: () => request<{ order: Order }>('/api/demo/reset', 'POST', {}),
    callAttempts: () =>
      request<{ attempts: CallAttemptSummary[] }>('/api/call-attempts'),
    callAttempt: (id: string) =>
      request<CallAttemptDetail>(
        `/api/call-attempts/${encodeURIComponent(id)}`,
      ),
    startPractice: () =>
      request<PracticeSession>('/api/practice-sessions', 'POST', {}),
    practiceOffer: (attemptId: string, sdp: string) =>
      request<PracticeAnswer>(
        `/api/practice-sessions/${encodeURIComponent(attemptId)}/offer`,
        'POST',
        { sdp, type: 'offer' },
      ),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
