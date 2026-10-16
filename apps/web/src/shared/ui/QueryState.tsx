import type { ReactNode } from 'react';

/** Loading, error (with retry) and empty states for a server-data view. */
export function QueryState({
  isPending,
  error,
  isEmpty,
  empty,
  onRetry,
  children,
}: {
  isPending: boolean;
  error: Error | null;
  isEmpty?: boolean;
  empty?: ReactNode;
  onRetry?: () => void;
  children: ReactNode;
}) {
  if (isPending)
    return (
      <p className="muted" role="status">
        Loading…
      </p>
    );
  if (error)
    return (
      <div className="inline-note" role="alert">
        {error.message}{' '}
        {onRetry && (
          <button className="text-button" onClick={onRetry}>
            Retry
          </button>
        )}
      </div>
    );
  if (isEmpty) return <>{empty}</>;
  return <>{children}</>;
}
