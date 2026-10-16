import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { USER_ROLES, type UserRole } from '@orderline/contracts';
import type { SessionUser, UserSummary } from '@orderline/contracts/api';
import { Badge } from '../../../shared/ui/Badge.js';
import { dateTime, label } from '../../../shared/ui/format.js';
import { QueryState } from '../../../shared/ui/QueryState.js';
import { useToast } from '../../../shared/ui/Toast.js';
import { usersService } from '../services/users.js';

export function UsersPage({ currentUser }: { currentUser: SessionUser }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const users = useQuery({ queryKey: ['users'], queryFn: usersService.list });
  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: ['users'] });
  const update = useMutation({
    mutationFn: ({
      id,
      change,
    }: {
      id: string;
      change: { role?: UserRole; disabled?: boolean };
    }) => usersService.update(id, change),
    onSuccess: () => {
      toast('Updated. That user’s existing sessions were signed out.');
      refresh();
    },
    onError: (error) => toast(error.message),
  });

  const rows = users.data?.users ?? [];
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">ADMINISTRATION</span>
          <h1>Team access</h1>
          <p>
            Viewers can review calls and transcripts. Administrators also change
            settings, users and deliveries.
          </p>
        </div>
      </div>
      <div className="settings-grid">
        <section className="panel">
          <div className="panel-heading">
            <h2>Users</h2>
            <span className="count-label">{rows.length}</span>
          </div>
          <QueryState
            isPending={users.isPending}
            error={users.error}
            onRetry={() => void users.refetch()}
          >
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>User</th>
                    <th>Role</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((user) => {
                    const self = user.id === currentUser.id;
                    return (
                      <tr key={user.id}>
                        <td>
                          <strong>{user.name}</strong>
                          <small>{user.email}</small>
                        </td>
                        <td>
                          <select
                            aria-label={`Role for ${user.email}`}
                            value={user.role}
                            disabled={self || update.isPending}
                            onChange={(e) =>
                              update.mutate({
                                id: user.id,
                                change: { role: e.target.value as UserRole },
                              })
                            }
                          >
                            {USER_ROLES.map((role) => (
                              <option key={role} value={role}>
                                {label(role)}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <Badge
                            value={user.disabled ? 'disabled' : 'active'}
                          />
                        </td>
                        <td>
                          {!self && (
                            <button
                              className="text-button"
                              disabled={update.isPending}
                              onClick={() =>
                                update.mutate({
                                  id: user.id,
                                  change: { disabled: !user.disabled },
                                })
                              }
                            >
                              {user.disabled ? 'Enable' : 'Disable'}
                            </button>
                          )}{' '}
                          <ResetPassword user={user} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </QueryState>
        </section>
        <NewUserForm onCreated={refresh} />
      </div>
      <AuditLog />
    </>
  );
}

function ResetPassword({ user }: { user: UserSummary }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  if (!open)
    return (
      <button className="text-button" onClick={() => setOpen(true)}>
        Reset password
      </button>
    );
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const password = String(new FormData(event.currentTarget).get('password'));
    try {
      await usersService.resetPassword(user.id, password);
      toast('Password reset. Share it with the user privately.');
      setOpen(false);
    } catch (error) {
      toast(
        error instanceof Error
          ? error.message
          : 'Could not reset the password.',
      );
    }
  }
  return (
    <form className="inline-form" onSubmit={submit}>
      <input
        name="password"
        type="password"
        autoComplete="new-password"
        minLength={12}
        required
        autoFocus
        aria-label={`New password for ${user.email}`}
        placeholder="New password"
      />
      <button className="text-button" type="submit">
        Save
      </button>
      <button
        className="text-button"
        type="button"
        onClick={() => setOpen(false)}
      >
        Cancel
      </button>
    </form>
  );
}

function NewUserForm({ onCreated }: { onCreated: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    try {
      await usersService.create({
        email: String(data.get('email')),
        name: String(data.get('name')),
        role: String(data.get('role')) as UserRole,
        password: String(data.get('password')),
      });
      form.reset();
      toast('User added. Share the password with them privately.');
      onCreated();
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not add the user.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>Add a user</h2>
      </div>
      <form className="settings-form" onSubmit={submit}>
        <fieldset disabled={busy}>
          <label htmlFor="new-name">Name</label>
          <input id="new-name" name="name" maxLength={80} required />
          <label htmlFor="new-email">Email</label>
          <input id="new-email" name="email" type="email" required />
          <label htmlFor="new-role">Role</label>
          <select id="new-role" name="role" defaultValue="viewer">
            {USER_ROLES.map((role) => (
              <option key={role} value={role}>
                {label(role)}
              </option>
            ))}
          </select>
          <label htmlFor="new-password">
            Initial password (12+ characters)
          </label>
          <input
            id="new-password"
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={12}
            required
          />
          <button className="primary" type="submit">
            Add user <span>→</span>
          </button>
        </fieldset>
      </form>
    </section>
  );
}

const ACTION_TEXT: Record<string, string> = {
  'auth.login': 'Signed in',
  'transcript.viewed': 'Viewed a customer transcript',
  'settings.updated': 'Changed agent settings',
  'practice.started': 'Started a practice session',
  'user.created': 'Added a user',
  'user.updated': 'Changed a user',
  'user.password_reset': 'Reset a password',
  'delivery.retried': 'Retried a result delivery',
};

function AuditLog() {
  const events = useQuery({
    queryKey: ['audit-events'],
    queryFn: usersService.audit,
  });
  const rows = events.data?.events ?? [];
  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>Activity log</h2>
        <span className="quiet-tag">LATEST 200</span>
      </div>
      <QueryState
        isPending={events.isPending}
        error={events.error}
        onRetry={() => void events.refetch()}
        isEmpty={rows.length === 0}
        empty={<p className="empty-small">No activity recorded yet.</p>}
      >
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Who</th>
                <th>What</th>
                <th>Subject</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((event) => (
                <tr key={event.id}>
                  <td>{dateTime(event.createdAt)}</td>
                  <td>{event.userEmail ?? '—'}</td>
                  <td>{ACTION_TEXT[event.action] ?? event.action}</td>
                  <td className="muted">{event.subjectId ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </QueryState>
    </section>
  );
}
