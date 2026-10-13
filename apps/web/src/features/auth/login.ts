import type { ApiClient } from '../../api/client.js';

export function renderLogin(
  app: HTMLElement,
  api: ApiClient,
  onSignedIn: () => Promise<void>,
) {
  app.innerHTML = `<main class="login"><div class="login-art"><div class="wordmark">orderline<span>●</span></div><span class="eyebrow">CUSTOMER CARE, WITH CLARITY</span><h1>One call.<br>A clear confirmation.</h1><p>Your order-confirmation workspace, powered by Gemini or Sarvam voice and Exotel.</p><div class="login-detail">Built for conversations that move orders forward.</div></div><form id="login" class="login-form"><span class="eyebrow">OPERATOR ACCESS</span><h2>Welcome to your workspace</h2><p>Sign in to manage the test agent and review calls.</p><label for="password">Operator password</label><input id="password" name="password" type="password" autocomplete="current-password" required placeholder="Enter your operator password"><p class="field-help">Use ADMIN_PASSWORD from the server’s local .env file.</p><button class="primary" type="submit">Open workspace <span>→</span></button><p id="login-error" class="form-error" role="alert"></p><small>Credentials stay on the server. Your session is private.</small></form></main>`;
  document.querySelector<HTMLFormElement>('#login')!.onsubmit = async (
    event,
  ) => {
    event.preventDefault();
    const button = document.querySelector<HTMLButtonElement>('#login button')!;
    button.disabled = true;
    try {
      const password = new FormData(event.currentTarget as HTMLFormElement).get(
        'password',
      );
      await api.login(String(password ?? ''));
      await onSignedIn();
    } catch (error) {
      document.querySelector('#login-error')!.textContent =
        error instanceof Error ? error.message : 'Could not sign in.';
    } finally {
      button.disabled = false;
    }
  };
}
