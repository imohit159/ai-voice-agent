import type { ReactNode } from 'react';
import type { SessionUser, WorkspaceState } from '@orderline/contracts/api';
import { label } from '../shared/ui/format.js';
import type { Page } from './routes.js';

const NAV: { page: Page; symbol: string; text: string; adminOnly?: boolean }[] =
  [
    { page: 'practice', symbol: '◉', text: 'Voice practice' },
    { page: 'calls', symbol: '◷', text: 'Call activity' },
    { page: 'deliveries', symbol: '⇄', text: 'Result delivery' },
    { page: 'settings', symbol: '⚙', text: 'Agent & connections' },
    { page: 'users', symbol: '◎', text: 'Team access', adminOnly: true },
  ];

export function Shell({
  state,
  user,
  page,
  onNavigate,
  onSignOut,
  children,
}: {
  state: WorkspaceState;
  user: SessionUser;
  page: Page;
  onNavigate: (page: Page) => void;
  onSignOut: () => void;
  children: ReactNode;
}) {
  const items = NAV.filter((item) => !item.adminOnly || user.role === 'admin');
  const current = items.find((item) => item.page === page);
  const initials = user.name
    .split(/\s+/)
    .map((part) => part.charAt(0))
    .join('')
    .slice(0, 2)
    .toUpperCase();
  return (
    <div className="workspace">
      <aside className="sidebar">
        <a className="wordmark" href="#/practice">
          orderline<span>●</span>
        </a>
        <div className="store-chip">
          <span className="store-initial">
            {state.settings.storeName.charAt(0)}
          </span>
          <div>
            <strong>{state.settings.storeName}</strong>
            <small>
              {state.connections.telephony.provider === 'plivo'
                ? 'Live calling'
                : 'Simulated calling'}
            </small>
          </div>
        </div>
        <span className="nav-label">WORKSPACE</span>
        <nav aria-label="Workspace">
          {items.map((item) => (
            <button
              key={item.page}
              className={`nav-item ${page === item.page ? 'selected' : ''}`}
              aria-current={page === item.page ? 'page' : undefined}
              onClick={() => onNavigate(item.page)}
            >
              <span className="nav-symbol" aria-hidden="true">
                {item.symbol}
              </span>
              {item.text}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <p>
            {user.name}
            <br />
            <small>{label(user.role)}</small>
          </p>
          <button className="text-button" onClick={onSignOut}>
            Sign out ↗
          </button>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <span>
            Workspace <span className="separator">/</span> {current?.text}
          </span>
          <div>
            <span className="operator-avatar" title={user.email}>
              {initials}
            </span>
          </div>
        </header>
        <main className="content">{children}</main>
        <footer>
          {state.settings.voiceProvider === 'sarvam' ? 'Sarvam' : 'Gemini Live'}{' '}
          voice <span>·</span>{' '}
          {state.connections.telephony.provider === 'plivo'
            ? 'Plivo'
            : 'Simulated'}{' '}
          telephony
        </footer>
      </div>
    </div>
  );
}
