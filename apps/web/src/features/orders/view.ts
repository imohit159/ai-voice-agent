import type { WorkspaceState } from '@orderline/contracts/api';
import { esc, badge } from '../../ui/format.js';
import { phoneConnectionNote } from '../settings/connections.js';

export type OrderFilter = 'all' | 'pending' | 'follow';

export function ordersPage(
  state: WorkspaceState,
  filter: OrderFilter,
  busy: boolean,
  practicePanel: string,
) {
  const order = state.orders[0]!;
  const visible = state.orders.filter(
    (o) =>
      filter === 'all' ||
      (filter === 'pending' ? !o.outcome : o.outcome === 'needs_follow_up'),
  );
  return `<div class="page-heading"><div><span class="eyebrow">ORDER OPERATIONS</span><h1>Order confirmations</h1><p>A short conversation. A confident next step.</p></div><button id="reset-demo" class="secondary">↺ Reset test order</button></div><div class="metrics"><div><span>Total test orders</span><strong>${state.orders.length}<small>Static sample data</small></strong></div><div><span>Confirmed</span><strong>${state.orders.filter((o) => o.outcome === 'confirmed').length}<small>Explicit customer decisions</small></strong></div><div><span>Needs follow up</span><strong>${state.orders.filter((o) => o.outcome === 'needs_follow_up').length}<small>Ready for operator review</small></strong></div></div><div class="work-grid"><div class="order-column"><section class="panel order-panel"><div class="panel-heading"><h2>Order queue <span class="count-label">${state.orders.length}</span></h2><span class="sample-tag">SAMPLE DATA</span></div><div class="tabs" role="group" aria-label="Order filters">${[
    ['all', 'All orders'],
    ['pending', 'Awaiting confirmation'],
    ['follow', 'Follow up'],
  ]
    .map(
      ([id, label]) =>
        `<button data-filter="${id}" class="${filter === id ? 'active' : ''}">${label}</button>`,
    )
    .join(
      '',
    )}</div><div class="table-wrap"><table><thead><tr><th>Customer / order</th><th>Total</th><th>Decision</th></tr></thead><tbody>${visible.length ? visible.map((o) => `<tr><td><div class="customer"><span class="customer-avatar">TC</span><div><strong>${esc(o.customerName)}</strong><small>${esc(o.id)}</small></div></div></td><td class="amount">₹${o.amount.toLocaleString('en-IN')}<small>${esc(o.currency)}</small></td><td>${badge(o.outcome)}</td></tr>`).join('') : '<tr><td colspan="3" class="empty-small">No orders in this view.</td></tr>'}</tbody></table></div><div class="order-detail"><div><span class="eyebrow">TEST ORDER DETAILS</span><h3>${esc(order.items)}</h3><p>${esc(order.address)}</p></div><div class="destination"><span>Test call recipient</span><strong>${esc(order.phone)}</strong></div></div><div class="call-action"><p><strong>Try the phone experience</strong><span>The agent calls this number with the sample order. Exotel and ${state.settings.voiceProvider === 'sarvam' ? 'Sarvam' : 'Gemini'} usage charges apply.</span></p><button id="phone-call" class="primary" ${!state.connections.exotelReady || busy ? 'disabled' : ''}>${busy ? 'Connecting…' : 'Call test number'} <span>↗</span></button></div>${!state.connections.exotelReady ? `<div class="inline-note">${esc(phoneConnectionNote(state))} <button data-page="settings">View connection →</button></div>` : ''}</section><section class="workflow-strip"><span class="eyebrow">HOW THE AGENT HANDLES A CALL</span><div><span><b>01</b> Introduce & verify</span><span><b>02</b> Read order details</span><span><b>03</b> Ask for a clear decision</span></div><p>Change requests and unclear answers are marked for follow up.</p></section></div><aside class="agent-column">${practicePanel}<div class="note-card"><span class="eyebrow">YOU STAY IN CONTROL</span><h3>A completed call isn’t a confirmed order.</h3><p>The agent records an outcome only after an explicit customer decision. Practice calls leave the test order unchanged.</p></div></aside></div>`;
}
