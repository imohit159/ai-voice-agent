import type { WorkspaceState } from '@orderline/contracts/api';
import { esc, badge } from '../../ui/format.js';
import type { CallDetail } from '@orderline/contracts/api';
import { time, transcriptHtml } from '../../ui/format.js';

export function callsPage(
  state: WorkspaceState,
  selectedCallId: string | null,
) {
  return `<div class="page-heading"><div><span class="eyebrow">CONVERSATION HISTORY</span><h1>Call activity</h1><p>See what happened, what was said, and what comes next.</p></div><button id="refresh" class="secondary">↻ Refresh</button></div><section class="panel"><div class="panel-heading"><h2>Recent calls</h2><span class="count-label">${state.calls.length}</span></div>${state.calls.length ? `<div class="table-wrap"><table><thead><tr><th>Started</th><th>Channel</th><th>Call status</th><th>Decision</th><th></th></tr></thead><tbody>${state.calls.map((call) => `<tr><td><strong>${esc(time(call.createdAt))}</strong><small>${esc(call.orderId)}</small></td><td>${call.mode === 'browser' ? 'Voice practice' : 'Exotel phone'}<small>${call.agentSettings?.voiceProvider === 'sarvam' ? 'Sarvam' : 'Gemini'}</small></td><td>${badge(call.status)}</td><td>${call.outcome ? badge(call.outcome) : '<span class="muted">No decision</span>'}</td><td><button class="text-button" data-call="${esc(call.id)}">View ↗</button></td></tr>`).join('')}</tbody></table></div>` : `<div class="empty-state"><span class="empty-symbol">◷</span><h3>Your first conversation starts here.</h3><p>Start a voice practice or connect Exotel to make a test call.</p><button data-page="orders" class="secondary">Go to test order →</button></div>`}</section><section id="call-detail" class="panel call-detail" ${selectedCallId ? '' : 'hidden'}></section>`;
}

export function callDetail(result: CallDetail) {
  return `<div class="panel-heading"><h2>Conversation details</h2>${badge(result.call.status)}</div><div class="detail-body"><p class="muted">${esc(result.call.id)} ${result.call.providerSid ? `· Exotel ${esc(result.call.providerSid)}` : ''}</p>${result.call.error ? `<p class="error-note">${esc(result.call.error)}</p>` : ''}${result.call.summary ? `<blockquote>${esc(result.call.summary)}</blockquote>` : ''}${result.call.mode === 'phone' && result.call.providerSid ? '<button id="reconcile" class="secondary">Check status with Exotel ↻</button>' : ''}<div class="transcript-history">${result.transcript.length ? transcriptHtml(result.transcript) : '<p class="muted">No transcript recorded for this call yet.</p>'}</div></div>`;
}
