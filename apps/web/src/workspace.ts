import type {
  WorkspaceState,
  StartCallRequest,
} from '@orderline/contracts/api';
import { createApiClient } from './api/client.js';
import { renderLogin } from './features/auth/login.js';
import { ordersPage, type OrderFilter } from './features/orders/view.js';
import { agentPanel } from './features/practice/view.js';
import { createPracticeController } from './features/practice/controller.js';
import { callsPage, callDetail } from './features/calls/view.js';
import { settingsPage } from './features/settings/view.js';
import { workspaceShell, type Page } from './ui/shell.js';

export function startWorkspace(app: HTMLElement) {
  let state: WorkspaceState;
  let authenticated = false;
  let page: Page = 'orders';
  let filter: OrderFilter = 'all';
  let selectedCallId: string | null = null;
  let busy = false;
  let latestRequest: StartCallRequest | null = null;
  let polling = false;
  const api = createApiClient(() => {
    authenticated = false;
    practice.stop();
    showLogin();
  });
  const practice = createPracticeController({
    api,
    isBusy: () => busy,
    setBusy: (value) => {
      busy = value;
    },
    render,
    toast,
    onCall: (id) => {
      selectedCallId = id;
    },
    onEnded: () =>
      void action(async () => {
        await refresh();
        if (page === 'orders') render();
      }),
  });
  function showLogin() {
    renderLogin(app, api, async () => {
      authenticated = true;
      await refresh();
      render();
    });
  }
  async function refresh() {
    state = await api.state();
  }
  function render() {
    if (!state || !authenticated) return;
    const content =
      page === 'orders'
        ? ordersPage(
            state,
            filter,
            busy,
            agentPanel(state, practice.snapshot(), busy),
          )
        : page === 'calls'
          ? callsPage(state, selectedCallId)
          : settingsPage(state);
    app.innerHTML = workspaceShell(state, page, content);
    bind();
  }
  function toast(message: string) {
    const element = document.querySelector<HTMLDivElement>('#toast')!;
    element.textContent = message;
    element.classList.add('visible');
    window.setTimeout(() => element.classList.remove('visible'), 6000);
  }
  function bind() {
    document.querySelectorAll<HTMLButtonElement>('[data-page]').forEach(
      (button) =>
        (button.onclick = () => {
          page = button.dataset.page as Page;
          render();
          if (page === 'calls' && selectedCallId) void loadCall(selectedCallId);
        }),
    );
    document.querySelectorAll<HTMLButtonElement>('[data-filter]').forEach(
      (button) =>
        (button.onclick = () => {
          filter = button.dataset.filter as OrderFilter;
          render();
        }),
    );
    document.querySelectorAll<HTMLButtonElement>('[data-logout]').forEach(
      (button) =>
        (button.onclick = () =>
          void action(async () => {
            practice.stop();
            await api.logout();
            authenticated = false;
            showLogin();
          })),
    );
    const reset = document.querySelector<HTMLButtonElement>('#reset-demo');
    if (reset)
      reset.onclick = () =>
        void action(async () => {
          await api.resetDemo();
          await refresh();
          render();
          toast('Test order reset. Call history is preserved.');
        });
    const practiceButton =
      document.querySelector<HTMLButtonElement>('#practice');
    if (practiceButton)
      practiceButton.onclick = () => {
        if (practice.snapshot().running) practice.stop();
        else void practice.start(state.orders[0]!.id);
      };
    const phone = document.querySelector<HTMLButtonElement>('#phone-call');
    if (phone) phone.onclick = () => void startPhone();
    document.querySelectorAll<HTMLButtonElement>('[data-call]').forEach(
      (button) =>
        (button.onclick = () => {
          selectedCallId = button.dataset.call!;
          void loadCall(selectedCallId);
        }),
    );
    const refreshButton = document.querySelector<HTMLButtonElement>('#refresh');
    if (refreshButton)
      refreshButton.onclick = () =>
        void action(async () => {
          await refresh();
          render();
          if (selectedCallId) await loadCall(selectedCallId);
        });
    const providerSelect =
      document.querySelector<HTMLSelectElement>('#voice-provider');
    if (providerSelect)
      providerSelect.onchange = () => {
        document.querySelector<HTMLElement>('#gemini-model-fields')!.hidden =
          providerSelect.value !== 'gemini';
        document.querySelector<HTMLElement>('#sarvam-model-fields')!.hidden =
          providerSelect.value !== 'sarvam';
      };
    const settingsForm =
      document.querySelector<HTMLFormElement>('#settings-form');
    if (settingsForm)
      settingsForm.onsubmit = (event) => {
        event.preventDefault();
        const data = new FormData(settingsForm);
        void action(async () => {
          await api.saveSettings(Object.fromEntries(data.entries()));
          await refresh();
          render();
          toast('Agent settings saved for the next call.');
        });
      };
  }
  async function action(work: () => Promise<void>) {
    try {
      await work();
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Something went wrong.');
    }
  }
  async function startPhone() {
    if (busy) return;
    busy = true;
    render();
    latestRequest ??= {
      orderId: state.orders[0]!.id,
      mode: 'phone',
      requestKey: crypto.randomUUID(),
    };
    try {
      const { call } = await api.startCall(latestRequest);
      latestRequest = null;
      selectedCallId = call.id;
      page = 'calls';
      await refresh();
      toast(call.error || 'Exotel accepted the test-call request.');
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Call request failed.');
    } finally {
      busy = false;
      render();
      if (page === 'calls' && selectedCallId) void loadCall(selectedCallId);
    }
  }
  async function loadCall(id: string) {
    await action(async () => {
      const result = await api.call(id);
      const panel = document.querySelector<HTMLElement>('#call-detail');
      if (!panel) return;
      panel.hidden = false;
      panel.innerHTML = callDetail(result);
      const button = document.querySelector<HTMLButtonElement>('#reconcile');
      if (button)
        button.onclick = () =>
          void action(async () => {
            button.disabled = true;
            try {
              await api.reconcileCall(id);
              await refresh();
              render();
              await loadCall(id);
            } finally {
              button.disabled = false;
            }
          });
    });
  }
  window.addEventListener('beforeunload', () => practice.stop());
  setInterval(() => {
    if (!state || polling || document.querySelector('#login')) return;
    polling = true;
    void refresh()
      .then(async () => {
        if (page === 'calls' && !busy) {
          render();
          if (selectedCallId) await loadCall(selectedCallId);
        }
      })
      .catch(() => {})
      .finally(() => {
        polling = false;
      });
  }, 6000);
  void api
    .session()
    .then(async (session) => {
      authenticated = session.authenticated;
      if (session.authenticated) {
        await refresh();
        render();
      } else showLogin();
    })
    .catch(() => {
      app.innerHTML =
        '<main class="fatal"><h1>Workspace unavailable</h1><p>Start the API server with pnpm dev, then reload.</p></main>';
    });
}
