import type {
  CallAttemptDetail,
  CallAttemptSummary,
} from '@orderline/contracts/api';
import { esc, badge, time, transcriptHtml } from '../../ui/format.js';

const channel = (attempt: CallAttemptSummary) =>
  attempt.source === 'practice' ? 'Voice practice' : 'Phone';
const provider = (attempt: CallAttemptSummary) =>
  attempt.agent
    ? attempt.agent.voiceProvider === 'sarvam'
      ? 'Sarvam'
      : 'Gemini'
    : '';

export function callsPage(
  attempts: CallAttemptSummary[],
  selectedCallId: string | null,
) {
  return `<div class="page-heading"><div><span class="eyebrow">CONVERSATION HISTORY</span><h1>Call activity</h1><p>Every call attempt and practice session, with what was said.</p></div><button id="refresh" class="secondary">↻ Refresh</button></div><section class="panel"><div class="panel-heading"><h2>Recent attempts</h2><span class="count-label">${attempts.length}</span></div>${
    attempts.length
      ? `<div class="table-wrap"><table><thead><tr><th>Started</th><th>Channel</th><th>Attempt</th><th>Request</th><th></th></tr></thead><tbody>${attempts
          .map(
            (attempt) =>
              `<tr><td><strong>${esc(time(attempt.startedAt))}</strong><small>${esc(attempt.source === 'practice' ? 'Practice' : attempt.orderRef)}</small></td><td>${channel(attempt)}<small>${provider(attempt)}</small></td><td>${badge(attempt.status)}<small>#${attempt.attemptNumber}</small></td><td>${badge(attempt.requestStatus)}</td><td><button class="text-button" data-call="${esc(attempt.id)}">View ↗</button></td></tr>`,
          )
          .join('')}</tbody></table></div>`
      : `<div class="empty-state"><span class="empty-symbol">◷</span><h3>Your first conversation starts here.</h3><p>Start a voice practice, or send a call request from your business system.</p><button data-page="orders" class="secondary">Go to practice →</button></div>`
  }</section><section id="call-detail" class="panel call-detail" ${selectedCallId ? '' : 'hidden'}></section>`;
}

export function callDetail({ attempt, transcript }: CallAttemptDetail) {
  return `<div class="panel-heading"><h2>Conversation details</h2>${badge(attempt.status)}</div><div class="detail-body"><p class="muted">${esc(attempt.id)} · ${channel(attempt)}${attempt.agent ? ` · ${esc(provider(attempt))} ${esc(attempt.agent.model)}` : ''}</p>${attempt.failureReason ? `<p class="error-note">${esc(attempt.failureReason)}</p>` : ''}<div class="transcript-history">${transcript.length ? transcriptHtml(transcript) : '<p class="muted">No transcript recorded for this attempt.</p>'}</div></div>`;
}
