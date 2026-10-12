import './style.css';
import { VOICE_PROVIDERS, SARVAM_MODELS, SARVAM_STT_MODELS, SARVAM_TTS_MODELS } from '../shared/models.js';
import { BrowserVoice } from './voice.js';
import type { Order, Call, Settings, Transcript } from '../shared/domain.js';

interface State {
  settings: Settings; orders: Order[]; calls: Call[];
  connections: { geminiConfigured: boolean; sarvamConfigured: boolean; selectedConfigured: boolean; geminiModel: string; exotelReady: boolean; missing: string[];
    callerId: string | null; testPhone: string; maxCallSeconds: number; maxConcurrentCalls: number };
}
const app = document.querySelector<HTMLDivElement>('#app')!;
let state: State;
let authenticated = false;
let page = 'orders';
let filter = 'all';
let voice: BrowserVoice | null = null;
let voiceStatus = 'idle';
let selectedCallId: string | null = null;
let liveTranscript: { role: string; text: string }[] = [];
let currentOutcome: string | null = null;
let busy = false;
let latestRequest: { orderId: string; mode: 'browser' | 'phone'; requestKey: string } | null = null;
let polling = false;
const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const labels: Record<string, string> = { confirmed: 'Confirmed', declined: 'Declined', needs_follow_up: 'Follow up', queued: 'Queued', connecting: 'Connecting', active: 'In progress', completed: 'Completed', failed: 'Failed', busy: 'Busy', no_answer: 'No answer', unknown: 'Check Exotel', configured: 'Configured', ready: 'Ready', missing: 'Setup needed', calling_disabled: 'Calling disabled' };
const badge = (value: string | null) => `<span class="badge ${esc(value || 'pending')}"><span class="dot"></span>${esc(value ? labels[value] ?? value : 'Awaiting confirmation')}</span>`;
const time = (date: string) => new Date(date).toLocaleString('en-IN', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...options?.headers } });
  const body = await response.json();
  if (!response.ok) {
    if (response.status === 401 && path !== '/api/login') { authenticated = false; voice?.stop(); renderLogin(); }
    throw new Error(body.error || 'Request failed.');
  }
  return body;
}
function toast(message: string) {
  const element = document.querySelector<HTMLDivElement>('#toast')!;
  element.textContent = message; element.classList.add('visible');
  window.setTimeout(() => element.classList.remove('visible'), 6000);
}
function renderLogin() {
  app.innerHTML = `<main class="login"><div class="login-art"><div class="wordmark">orderline<span>●</span></div><span class="eyebrow">CUSTOMER CARE, WITH CLARITY</span><h1>One call.<br>A clear confirmation.</h1><p>Your order-confirmation workspace, powered by Gemini or Sarvam voice and Exotel.</p><div class="login-detail">Built for conversations that move orders forward.</div></div><form id="login" class="login-form"><span class="eyebrow">OPERATOR ACCESS</span><h2>Welcome to your workspace</h2><p>Sign in to manage the test agent and review calls.</p><label for="password">Operator password</label><input id="password" name="password" type="password" autocomplete="current-password" required placeholder="Enter your operator password"><p class="field-help">Use ADMIN_PASSWORD from the server’s local .env file.</p><button class="primary" type="submit">Open workspace <span>→</span></button><p id="login-error" class="form-error" role="alert"></p><small>Credentials stay on the server. Your session is private.</small></form></main>`;
  document.querySelector<HTMLFormElement>('#login')!.onsubmit = async event => {
    event.preventDefault();
    const button = document.querySelector<HTMLButtonElement>('#login button')!;
    button.disabled = true;
    try {
      const password = new FormData(event.currentTarget as HTMLFormElement).get('password');
      await api('/api/login', { method: 'POST', body: JSON.stringify({ password }) });
      authenticated = true;
      await refresh(); render();
    } catch (error) { document.querySelector('#login-error')!.textContent = error instanceof Error ? error.message : 'Could not sign in.'; }
    finally { button.disabled = false; }
  };
}
async function refresh() { state = await api<State>('/api/state'); }
function render() {
  if (!state || !authenticated) return;
  app.innerHTML = `<div class="workspace"><aside class="sidebar"><a class="wordmark" href="#">orderline<span>●</span></a><div class="store-chip"><span class="store-initial">${esc(state.settings.storeName.charAt(0))}</span><div><strong>${esc(state.settings.storeName)}</strong><small>Test workspace</small></div><span class="chevron">⌄</span></div><span class="nav-label">WORKSPACE</span><nav aria-label="Workspace">${[['orders', '▤', 'Orders'], ['calls', '◷', 'Call activity'], ['settings', '⚙', 'Agent & connections']].map(([id, symbol, label]) => `<button class="nav-item ${page === id ? 'selected' : ''}" data-page="${id}"><span class="nav-symbol" aria-hidden="true">${symbol}</span>${label}${id === 'orders' ? `<span class="nav-count">${state.orders.length}</span>` : ''}</button>`).join('')}</nav><div class="sidebar-bottom"><div class="small-status"><span class="dot"></span>Demo environment</div><p>Static order data.<br>Real conversations.</p><button data-logout class="text-button">Sign out ↗</button></div></aside><div class="main"><header class="topbar"><span>Workspace <span class="separator">/</span> ${page === 'orders' ? 'Orders' : page === 'calls' ? 'Call activity' : 'Agent & connections'}</span><div><span class="quiet-tag">TEST MODE</span><button data-logout class="text-button topbar-logout">Sign out</button><span class="operator-avatar" title="Operator">OP</span></div></header><main class="content">${page === 'orders' ? ordersPage() : page === 'calls' ? callsPage() : settingsPage()}</main><footer>${state.settings.voiceProvider === 'sarvam' ? 'Sarvam' : 'Gemini'} voice <span>·</span> Exotel telephony <span class="footer-right">Order decisions are recorded locally.</span></footer></div></div>`;
  bind();
}
function phoneConnectionStatus(): 'ready' | 'calling_disabled' | 'missing' {
  const { exotelReady, missing } = state.connections;
  if (exotelReady) return 'ready';
  return missing.length === 1 && missing[0] === 'ENABLE_PHONE_CALLS' ? 'calling_disabled' : 'missing';
}
function phoneConnectionNote(): string {
  switch (phoneConnectionStatus()) {
    case 'ready': return 'Configured for test calling. Account and AgentStream access are verified when a call is placed.';
    case 'calling_disabled': return 'Credentials and public URL are configured. Phone calls are disabled on this server. Confirm Exotel bidirectional streaming access before enabling test calls.';
    case 'missing': return 'Finish the calling configuration to enable test calls.';
  }
}
function ordersPage() {
  const order = state.orders[0]!;
  const visible = state.orders.filter(o => filter === 'all' || (filter === 'pending' ? !o.outcome : o.outcome === 'needs_follow_up'));
  return `<div class="page-heading"><div><span class="eyebrow">ORDER OPERATIONS</span><h1>Order confirmations</h1><p>A short conversation. A confident next step.</p></div><button id="reset-demo" class="secondary">↺ Reset test order</button></div><div class="metrics"><div><span>Total test orders</span><strong>${state.orders.length}<small>Static sample data</small></strong></div><div><span>Confirmed</span><strong>${state.orders.filter(o => o.outcome === 'confirmed').length}<small>Explicit customer decisions</small></strong></div><div><span>Needs follow up</span><strong>${state.orders.filter(o => o.outcome === 'needs_follow_up').length}<small>Ready for operator review</small></strong></div></div><div class="work-grid"><div class="order-column"><section class="panel order-panel"><div class="panel-heading"><h2>Order queue <span class="count-label">${state.orders.length}</span></h2><span class="sample-tag">SAMPLE DATA</span></div><div class="tabs" role="group" aria-label="Order filters">${[['all', 'All orders'], ['pending', 'Awaiting confirmation'], ['follow', 'Follow up']].map(([id, label]) => `<button data-filter="${id}" class="${filter === id ? 'active' : ''}">${label}</button>`).join('')}</div><div class="table-wrap"><table><thead><tr><th>Customer / order</th><th>Total</th><th>Decision</th></tr></thead><tbody>${visible.length ? visible.map(o => `<tr><td><div class="customer"><span class="customer-avatar">TC</span><div><strong>${esc(o.customerName)}</strong><small>${esc(o.id)}</small></div></div></td><td class="amount">₹${o.amount.toLocaleString('en-IN')}<small>${esc(o.currency)}</small></td><td>${badge(o.outcome)}</td></tr>`).join('') : '<tr><td colspan="3" class="empty-small">No orders in this view.</td></tr>'}</tbody></table></div><div class="order-detail"><div><span class="eyebrow">TEST ORDER DETAILS</span><h3>${esc(order.items)}</h3><p>${esc(order.address)}</p></div><div class="destination"><span>Test call recipient</span><strong>${esc(order.phone)}</strong></div></div><div class="call-action"><p><strong>Try the phone experience</strong><span>The agent calls this number with the sample order. Exotel and ${state.settings.voiceProvider === 'sarvam' ? 'Sarvam' : 'Gemini'} usage charges apply.</span></p><button id="phone-call" class="primary" ${!state.connections.exotelReady || busy ? 'disabled' : ''}>${busy ? 'Connecting…' : 'Call test number'} <span>↗</span></button></div>${!state.connections.exotelReady ? `<div class="inline-note">${esc(phoneConnectionNote())} <button data-page="settings">View connection →</button></div>` : ''}</section><section class="workflow-strip"><span class="eyebrow">HOW THE AGENT HANDLES A CALL</span><div><span><b>01</b> Introduce & verify</span><span><b>02</b> Read order details</span><span><b>03</b> Ask for a clear decision</span></div><p>Change requests and unclear answers are marked for follow up.</p></section></div><aside class="agent-column">${agentPanel()}<div class="note-card"><span class="eyebrow">YOU STAY IN CONTROL</span><h3>A completed call isn’t a confirmed order.</h3><p>The agent records an outcome only after an explicit customer decision. Practice calls leave the test order unchanged.</p></div></aside></div>`;
}
function agentPanel() {
  const running = voice !== null;
  const statusText: Record<string, string> = { idle: 'Ready for a conversation', connecting: 'Connecting to your agent…', listening: 'Listening to you', speaking: 'Your agent is speaking', ended: 'Practice complete' };
  return `<section class="panel agent-panel"><div class="panel-heading"><h2>Meet your voice agent</h2><span class="live-label"><span class="dot"></span>${running ? 'LIVE' : 'PRACTICE'}</span></div><div class="agent-stage ${running ? 'running' : ''}"><div class="soundmark" aria-hidden="true">${Array.from({ length: 9 }, () => `<i></i>`).join('')}</div><h3 id="voice-status">${statusText[voiceStatus] ?? 'Ready'}</h3><p>${esc(state.settings.storeName)} <span>·</span> ${esc(state.settings.language)}</p></div><div class="practice-copy"><strong>Talk through a test order</strong><p>Use your microphone to experience the same conversation before placing a phone call.</p></div><button id="practice" class="${running ? 'stop-button' : 'secondary'}" ${(busy || !state.connections.selectedConfigured) && !running ? 'disabled' : ''}>${running ? 'End practice' : 'Start voice practice'} <span>${running ? '■' : '→'}</span></button><small class="practice-note">${state.connections.selectedConfigured ? `Uses ${state.settings.voiceProvider === 'sarvam' ? 'Sarvam' : 'Gemini'} API · No phone call is placed` : `Add ${state.settings.voiceProvider === 'sarvam' ? 'SARVAM_API_KEY' : 'GEMINI_API_KEY'} in the server .env to start`}</small><div id="live-result">${currentOutcome ? badge(currentOutcome) : ''}</div><div id="live-transcript" class="live-transcript" aria-live="polite">${transcriptHtml(liveTranscript)}</div></section>`;
}
function transcriptHtml(items: { role: string; text: string }[]) {
  const turns: { role: string; text: string }[] = [];
  for (const item of items) {
    const last = turns.at(-1);
    if (last?.role === item.role) last.text += item.text;
    else turns.push({ ...item });
  }
  return turns.map(t => `<div class="transcript-turn"><span>${t.role === 'agent' ? 'AGENT' : 'CUSTOMER'}</span><p>${esc(t.text)}</p></div>`).join('');
}
function callsPage() {
  return `<div class="page-heading"><div><span class="eyebrow">CONVERSATION HISTORY</span><h1>Call activity</h1><p>See what happened, what was said, and what comes next.</p></div><button id="refresh" class="secondary">↻ Refresh</button></div><section class="panel"><div class="panel-heading"><h2>Recent calls</h2><span class="count-label">${state.calls.length}</span></div>${state.calls.length ? `<div class="table-wrap"><table><thead><tr><th>Started</th><th>Channel</th><th>Call status</th><th>Decision</th><th></th></tr></thead><tbody>${state.calls.map(call => `<tr><td><strong>${esc(time(call.createdAt))}</strong><small>${esc(call.orderId)}</small></td><td>${call.mode === 'browser' ? 'Voice practice' : 'Exotel phone'}<small>${call.agentSettings?.voiceProvider === 'sarvam' ? 'Sarvam' : 'Gemini'}</small></td><td>${badge(call.status)}</td><td>${call.outcome ? badge(call.outcome) : '<span class="muted">No decision</span>'}</td><td><button class="text-button" data-call="${esc(call.id)}">View ↗</button></td></tr>`).join('')}</tbody></table></div>` : `<div class="empty-state"><span class="empty-symbol">◷</span><h3>Your first conversation starts here.</h3><p>Start a voice practice or connect Exotel to make a test call.</p><button data-page="orders" class="secondary">Go to test order →</button></div>`}</section><section id="call-detail" class="panel call-detail" ${selectedCallId ? '' : 'hidden'}></section>`;
}
function modelSelect(name: 'sarvamModel' | 'sarvamSttModel' | 'sarvamTtsModel', label: string, models: readonly string[]) {
  return `<label for="${name}">${label}</label><select id="${name}" name="${name}">${models.map(model => `<option ${state.settings[name] === model ? 'selected' : ''}>${esc(model)}</option>`).join('')}</select>`;
}
function settingsPage() {
  const c = state.connections;
  const callingDisabled = phoneConnectionStatus() === 'calling_disabled';
  const setupSteps = callingDisabled
    ? '<li>Ask Exotel to confirm bidirectional AgentStream / Connect Voice AI access and the API hostname for your account.</li><li>After streaming access is confirmed, set <code>ENABLE_PHONE_CALLS=true</code> in the server <code>.env</code> and restart the server.</li>'
    : '<li>Add your account SID, API key, API token, and ExoPhone to the server <code>.env</code>.</li><li>Enable Exotel’s bidirectional AgentStream / Connect Voice AI for your account.</li><li>Set your public HTTPS URL and <code>ENABLE_PHONE_CALLS=true</code>, then restart the server.</li>';
  return `<div class="page-heading"><div><span class="eyebrow">AGENT CONFIGURATION</span><h1>Your agent, your way.</h1><p>Choose Gemini or Sarvam, set your models and connect your calling account.</p></div></div><div class="settings-grid"><section class="panel"><div class="panel-heading"><h2>Conversation settings</h2><span class="sample-tag">CONFIGURABLE</span></div><form id="settings-form" class="settings-form"><label for="store-name">Store name</label><input id="store-name" name="storeName" value="${esc(state.settings.storeName)}" required maxlength="80"><label for="language">Conversation language</label><select id="language" name="language">${['Hindi', 'English', 'Hindi and English'].map(lang => `<option ${state.settings.language === lang ? 'selected' : ''}>${lang}</option>`).join('')}</select><label for="voice-provider">AI voice provider</label><select id="voice-provider" name="voiceProvider">${VOICE_PROVIDERS.map(provider => `<option value="${provider}" ${state.settings.voiceProvider === provider ? 'selected' : ''}>${provider === 'gemini' ? 'Gemini Live' : 'Sarvam'}</option>`).join('')}</select><div id="gemini-model-fields" ${state.settings.voiceProvider === 'gemini' ? '' : 'hidden'}><label for="gemini-model">Gemini Live model</label><input id="gemini-model" name="geminiModel" value="${esc(state.settings.geminiModel)}" maxlength="120" required></div><div id="sarvam-model-fields" ${state.settings.voiceProvider === 'sarvam' ? '' : 'hidden'}>${modelSelect('sarvamModel', 'Sarvam conversation model', SARVAM_MODELS)}${modelSelect('sarvamSttModel', 'Sarvam speech recognition', SARVAM_STT_MODELS)}${modelSelect('sarvamTtsModel', 'Sarvam voice synthesis', SARVAM_TTS_MODELS)}<p class="field-help">Sarvam uses speech recognition, a conversation model and voice synthesis. The default voice follows the selected synthesis model.</p></div><p class="field-help">Changes apply to the next conversation. The agent identifies every sample-data call as a test.</p><button class="primary" type="submit">Save agent settings <span>→</span></button></form><div class="settings-foot"><span>Maximum duration <strong>${c.maxCallSeconds}s</strong></span><span>Concurrent attempts <strong>${c.maxConcurrentCalls}</strong></span></div></section><div><section class="panel connection"><div class="panel-heading"><h2>Connections</h2><span class="quiet-tag">SERVER SIDE</span></div><div class="connection-row"><span class="connection-initial">G</span><div><strong>Gemini Live</strong><small>${esc(state.settings.geminiModel)}</small></div>${badge(c.geminiConfigured ? 'configured' : 'missing')}</div><p class="connection-note">${c.geminiConfigured ? 'A key is configured. Voice practice verifies access to the selected model.' : 'Set GEMINI_API_KEY in the server .env file.'}</p><div class="connection-row"><span class="connection-initial">S</span><div><strong>Sarvam</strong><small>${esc(state.settings.sarvamModel)}</small></div>${badge(c.sarvamConfigured ? 'configured' : 'missing')}</div><p class="connection-note">${c.sarvamConfigured ? 'A key is configured. Use voice practice to verify access to all three selected models.' : 'Set SARVAM_API_KEY in the server .env file, then restart.'}</p><div class="connection-row"><span class="connection-initial">E</span><div><strong>Exotel</strong><small>${c.callerId ? `Business number: ${esc(c.callerId)}` : 'Business number not configured'}</small></div>${badge(phoneConnectionStatus())}</div><p class="connection-note">${esc(phoneConnectionNote())}</p></section><section class="setup-card"><h3>${callingDisabled ? 'Enable test calling' : 'Connect your Exotel account'}</h3><ol>${setupSteps}</ol>${c.missing.length ? `<details><summary>Configuration still needed (${c.missing.length})</summary><ul>${c.missing.map(name => `<li><code>${esc(name)}</code></li>`).join('')}</ul></details>` : ''}<p>Use an Exotel business number as the caller ID. Your test recipient remains ${esc(c.testPhone)}.</p></section></div></div>`;
}
function bind() {
  document.querySelectorAll<HTMLButtonElement>('[data-page]').forEach(button => button.onclick = () => { page = button.dataset.page!; render(); if (page === 'calls' && selectedCallId) void loadCall(selectedCallId); });
  document.querySelectorAll<HTMLButtonElement>('[data-filter]').forEach(button => button.onclick = () => { filter = button.dataset.filter!; render(); });
  document.querySelectorAll<HTMLButtonElement>('[data-logout]').forEach(button => button.onclick = () => void action(async () => { voice?.stop(); await api('/api/logout', { method: 'POST', body: '{}' }); authenticated = false; renderLogin(); }));
  const reset = document.querySelector<HTMLButtonElement>('#reset-demo');
  if (reset) reset.onclick = () => void action(async () => { await api('/api/demo/reset', { method: 'POST', body: '{}' }); await refresh(); render(); toast('Test order reset. Call history is preserved.'); });
  const practice = document.querySelector<HTMLButtonElement>('#practice');
  if (practice) practice.onclick = () => { if (voice) voice.stop(); else void startPractice(); };
  const phone = document.querySelector<HTMLButtonElement>('#phone-call');
  if (phone) phone.onclick = () => void startPhone();
  document.querySelectorAll<HTMLButtonElement>('[data-call]').forEach(button => button.onclick = () => { selectedCallId = button.dataset.call!; void loadCall(selectedCallId); });
  const refreshButton = document.querySelector<HTMLButtonElement>('#refresh');
  if (refreshButton) refreshButton.onclick = () => void action(async () => { await refresh(); render(); if (selectedCallId) await loadCall(selectedCallId); });
  const providerSelect = document.querySelector<HTMLSelectElement>('#voice-provider');
  if (providerSelect) providerSelect.onchange = () => {
    document.querySelector<HTMLElement>('#gemini-model-fields')!.hidden = providerSelect.value !== 'gemini';
    document.querySelector<HTMLElement>('#sarvam-model-fields')!.hidden = providerSelect.value !== 'sarvam';
  };
  const settingsForm = document.querySelector<HTMLFormElement>('#settings-form');
  if (settingsForm) settingsForm.onsubmit = event => {
    event.preventDefault(); const data = new FormData(settingsForm);
    void action(async () => { await api('/api/settings', { method: 'PUT', body: JSON.stringify(Object.fromEntries(data.entries())) }); await refresh(); render(); toast('Agent settings saved for the next call.'); });
  };
}
async function action(work: () => Promise<void>) { try { await work(); } catch (error) { toast(error instanceof Error ? error.message : 'Something went wrong.'); } }
async function startPractice() {
  if (busy || voice) return;
  busy = true; liveTranscript = []; currentOutcome = null;
  const instance = new BrowserVoice({
    status: status => {
      voiceStatus = status;
      if (status === 'ended') { voice = null; busy = false; void action(async () => { await refresh(); if (page === 'orders') render(); }); }
      const element = document.querySelector('#voice-status');
      if (element) element.textContent = ({ connecting: 'Connecting to your agent…', listening: 'Listening to you', speaking: 'Your agent is speaking', ended: 'Practice complete' })[status];
    },
    transcript: (role, text) => {
      liveTranscript.push({ role, text });
      const element = document.querySelector('#live-transcript');
      if (element) { element.innerHTML = transcriptHtml(liveTranscript); element.scrollTop = element.scrollHeight; }
    },
    outcome: outcome => { currentOutcome = outcome; const element = document.querySelector('#live-result'); if (element) element.innerHTML = badge(outcome); },
    error: toast,
  });
  voice = instance; voiceStatus = 'connecting'; render();
  try {
    await instance.prepare();
    if (voice !== instance) return;
    const result = await api<{ call: Call; token: string }>('/api/calls', { method: 'POST', body: JSON.stringify({ orderId: state.orders[0]!.id, mode: 'browser', requestKey: crypto.randomUUID() }) });
    selectedCallId = result.call.id; instance.connect(result.token); busy = false;
  } catch (error) { instance.stop(); toast(error instanceof Error ? error.message : 'Could not start practice.'); }
}
async function startPhone() {
  if (busy) return;
  busy = true; render();
  latestRequest ??= { orderId: state.orders[0]!.id, mode: 'phone', requestKey: crypto.randomUUID() };
  try {
    const { call } = await api<{ call: Call }>('/api/calls', { method: 'POST', body: JSON.stringify(latestRequest) });
    latestRequest = null; selectedCallId = call.id; page = 'calls';
    await refresh();
    toast(call.error || 'Exotel accepted the test-call request.');
  } catch (error) { toast(error instanceof Error ? error.message : 'Call request failed.'); }
  finally { busy = false; render(); if (page === 'calls' && selectedCallId) void loadCall(selectedCallId); }
}
async function loadCall(id: string) {
  await action(async () => {
    const result = await api<{ call: Call; transcript: Transcript[] }>(`/api/calls/${id}`);
    const panel = document.querySelector<HTMLElement>('#call-detail'); if (!panel) return;
    panel.hidden = false;
    panel.innerHTML = `<div class="panel-heading"><h2>Conversation details</h2>${badge(result.call.status)}</div><div class="detail-body"><p class="muted">${esc(result.call.id)} ${result.call.providerSid ? `· Exotel ${esc(result.call.providerSid)}` : ''}</p>${result.call.error ? `<p class="error-note">${esc(result.call.error)}</p>` : ''}${result.call.summary ? `<blockquote>${esc(result.call.summary)}</blockquote>` : ''}${result.call.mode === 'phone' && result.call.providerSid ? '<button id="reconcile" class="secondary">Check status with Exotel ↻</button>' : ''}<div class="transcript-history">${result.transcript.length ? transcriptHtml(result.transcript) : '<p class="muted">No transcript recorded for this call yet.</p>'}</div></div>`;
    const button = document.querySelector<HTMLButtonElement>('#reconcile');
    if (button) button.onclick = () => void action(async () => { button.disabled = true; try { await api(`/api/calls/${id}/reconcile`, { method: 'POST', body: '{}' }); await refresh(); render(); await loadCall(id); } finally { button.disabled = false; } });
  });
}
window.addEventListener('beforeunload', () => voice?.stop());
setInterval(() => {
  if (!state || polling || document.querySelector('#login')) return;
  polling = true;
  void refresh().then(async () => { if (page === 'calls' && !busy) { render(); if (selectedCallId) await loadCall(selectedCallId); } }).catch(() => {}).finally(() => { polling = false; });
}, 6000);
void api<{ authenticated: boolean }>('/api/session').then(async session => { authenticated = session.authenticated; if (session.authenticated) { await refresh(); render(); } else renderLogin(); }).catch(() => { app.innerHTML = '<main class="fatal"><h1>Workspace unavailable</h1><p>Start the API server with pnpm dev, then reload.</p></main>'; });
