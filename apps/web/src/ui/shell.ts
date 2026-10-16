import type { WorkspaceState } from '@orderline/contracts/api';
import { esc } from './format.js';

export type Page = 'orders' | 'calls' | 'settings';

export function workspaceShell(
  state: WorkspaceState,
  page: Page,
  content: string,
) {
  return `<div class="workspace"><aside class="sidebar"><a class="wordmark" href="#">orderline<span>●</span></a><div class="store-chip"><span class="store-initial">${esc(state.settings.storeName.charAt(0))}</span><div><strong>${esc(state.settings.storeName)}</strong><small>Test workspace</small></div><span class="chevron">⌄</span></div><span class="nav-label">WORKSPACE</span><nav aria-label="Workspace">${[
    ['orders', '▤', 'Orders'],
    ['calls', '◷', 'Call activity'],
    ['settings', '⚙', 'Agent & connections'],
  ]
    .map(
      ([id, symbol, label]) =>
        `<button class="nav-item ${page === id ? 'selected' : ''}" data-page="${id}"><span class="nav-symbol" aria-hidden="true">${symbol}</span>${label}${id === 'orders' ? `<span class="nav-count">${state.orders.length}</span>` : ''}</button>`,
    )
    .join(
      '',
    )}</nav><div class="sidebar-bottom"><div class="small-status"><span class="dot"></span>Demo environment</div><p>Static order data.<br>Real conversations.</p><button data-logout class="text-button">Sign out ↗</button></div></aside><div class="main"><header class="topbar"><span>Workspace <span class="separator">/</span> ${page === 'orders' ? 'Orders' : page === 'calls' ? 'Call activity' : 'Agent & connections'}</span><div><span class="quiet-tag">TEST MODE</span><button data-logout class="text-button topbar-logout">Sign out</button><span class="operator-avatar" title="Operator">OP</span></div></header><main class="content">${content}</main><footer>${state.settings.voiceProvider === 'sarvam' ? 'Sarvam' : 'Gemini'} voice <span>·</span> ${state.connections.telephony.provider === 'plivo' ? 'Plivo' : 'Simulated'} telephony <span class="footer-right">Order decisions are recorded locally.</span></footer></div></div>`;
}
