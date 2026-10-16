// The single HTTP entry point: JSON, timeouts, error shape and session expiry.
// Components never call fetch directly; feature services call this.

const TIMEOUT_MS = 20_000;

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly fields: string[] = [],
  ) {
    super(message);
  }
}

const unauthorizedListeners = new Set<() => void>();

/** Notified whenever the API reports the session is gone (expired, disabled, signed out elsewhere). */
export function onUnauthorized(listener: () => void): () => void {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
}

export async function request<T>(
  path: string,
  options: { method?: 'GET' | 'POST' | 'PUT' | 'PATCH'; body?: unknown } = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: options.method ?? 'GET',
      headers:
        options.body === undefined
          ? undefined
          : { 'Content-Type': 'application/json' },
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
      credentials: 'same-origin',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new ApiError(
      0,
      'The server is not reachable. Check your connection and retry.',
    );
  }
  const data = (await response.json().catch(() => ({}))) as {
    error?: string;
    fields?: string[];
  };
  if (!response.ok) {
    if (response.status === 401 && path !== '/api/login')
      unauthorizedListeners.forEach((listener) => listener());
    throw new ApiError(
      response.status,
      data.error ?? 'The request failed.',
      data.fields,
    );
  }
  return data as T;
}
