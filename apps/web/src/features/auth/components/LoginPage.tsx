import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { authService } from '../services/auth.js';
import { SESSION_KEY } from '../hooks/useSession.js';

export function LoginPage() {
  const queryClient = useQueryClient();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try {
      const session = await authService.login(
        String(form.get('email') ?? ''),
        String(form.get('password') ?? ''),
      );
      queryClient.setQueryData(SESSION_KEY, session);
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : 'Could not sign in.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <div className="login-art">
        <div className="wordmark">
          orderline<span>●</span>
        </div>
        <span className="eyebrow">CUSTOMER CARE, WITH CLARITY</span>
        <h1>
          One call.
          <br />A clear confirmation.
        </h1>
        <p>
          Your order-confirmation workspace: calls, transcripts and outcomes in
          one place.
        </p>
      </div>
      <form className="login-form" onSubmit={submit}>
        <span className="eyebrow">TEAM ACCESS</span>
        <h2>Sign in</h2>
        <label htmlFor="email">Email</label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          required
          autoFocus
        />
        <label htmlFor="password">Password</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
        <button className="primary" type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'} <span>→</span>
        </button>
        <p className="form-error" role="alert">
          {error}
        </p>
        <small>Ask an administrator if you need an account.</small>
      </form>
    </main>
  );
}
