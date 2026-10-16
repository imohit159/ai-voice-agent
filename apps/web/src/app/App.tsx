import { useQuery } from '@tanstack/react-query';
import type { SessionInfo } from '@orderline/contracts/api';
import { LoginPage } from '../features/auth/components/LoginPage.js';
import { useSession, useSignedIn } from '../features/auth/hooks/useSession.js';
import { CallsPage } from '../features/calls/components/CallsPage.js';
import { DeliveriesPage } from '../features/deliveries/components/DeliveriesPage.js';
import { PracticePage } from '../features/practice/components/PracticePage.js';
import { SettingsPage } from '../features/settings/components/SettingsPage.js';
import { settingsService } from '../features/settings/services/settings.js';
import { UsersPage } from '../features/users/components/UsersPage.js';
import { QueryState } from '../shared/ui/QueryState.js';
import { useRoute } from './routes.js';
import { Shell } from './Shell.js';

export function App() {
  const session = useSession();
  if (session.isPending)
    return (
      <p className="muted" role="status">
        Loading…
      </p>
    );
  if (session.error)
    return (
      <main className="fatal">
        <h1>Workspace unavailable</h1>
        <p>{session.error.message}</p>
      </main>
    );
  if (!session.data.authenticated || !session.data.user) return <LoginPage />;
  return <Workspace session={session.data} />;
}

function Workspace({ session }: { session: SessionInfo }) {
  const { route, navigate } = useRoute();
  const { signOut, isAdmin } = useSignedIn(session);
  const workspace = useQuery({
    queryKey: ['workspace'],
    queryFn: settingsService.state,
    refetchInterval: 30_000,
  });
  const user = session.user!;
  // A viewer following an admin link lands on a page they can use.
  const page = route.page === 'users' && !isAdmin ? 'practice' : route.page;

  return (
    <QueryState
      isPending={workspace.isPending}
      error={workspace.error}
      onRetry={() => void workspace.refetch()}
    >
      {workspace.data && (
        <Shell
          state={workspace.data}
          user={user}
          page={page}
          onNavigate={(next) => navigate(next)}
          onSignOut={() => void signOut()}
        >
          {page === 'practice' && <PracticePage state={workspace.data} />}
          {page === 'calls' && (
            <CallsPage
              selectedId={route.id}
              select={(id) => navigate('calls', id)}
            />
          )}
          {page === 'deliveries' && <DeliveriesPage isAdmin={isAdmin} />}
          {page === 'settings' && (
            // Keyed so the form resets when the saved settings change.
            <SettingsPage
              key={JSON.stringify(workspace.data.settings)}
              state={workspace.data}
              isAdmin={isAdmin}
            />
          )}
          {page === 'users' && isAdmin && <UsersPage currentUser={user} />}
        </Shell>
      )}
    </QueryState>
  );
}
