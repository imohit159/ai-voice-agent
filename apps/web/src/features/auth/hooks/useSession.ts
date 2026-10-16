import { useEffect } from 'react';
import {
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import type { SessionInfo } from '@orderline/contracts/api';
import { onUnauthorized } from '../../../shared/api/client.js';
import { authService } from '../services/auth.js';

export const SESSION_KEY = ['session'] as const;
const SIGNED_OUT: SessionInfo = { authenticated: false, user: null };

/**
 * Drops every cached query except the session itself, then marks it signed out.
 * Clearing the whole cache would detach the session observer and leave the
 * signed-out user looking at a stale screen.
 */
function signOutLocally(queryClient: QueryClient) {
  queryClient.removeQueries({
    predicate: (query) => query.queryKey[0] !== SESSION_KEY[0],
  });
  queryClient.setQueryData(SESSION_KEY, SIGNED_OUT);
}

export function useSession() {
  const queryClient = useQueryClient();
  // Any 401 anywhere means the session ended: drop cached data and show sign-in.
  useEffect(
    () => onUnauthorized(() => signOutLocally(queryClient)),
    [queryClient],
  );
  return useQuery({
    queryKey: SESSION_KEY,
    queryFn: authService.session,
    staleTime: Infinity,
  });
}

export function useSignedIn(session: SessionInfo) {
  const queryClient = useQueryClient();
  return {
    signedIn: (next: SessionInfo) =>
      queryClient.setQueryData(SESSION_KEY, next),
    signOut: async () => {
      await authService.logout().catch(() => {});
      signOutLocally(queryClient);
    },
    isAdmin: session.user?.role === 'admin',
  };
}
