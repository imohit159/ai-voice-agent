export const esc = (value: unknown) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        char
      ]!,
  );
const labels: Record<string, string> = {
  confirmed: 'Confirmed',
  declined: 'Declined',
  needs_follow_up: 'Follow up',
  queued: 'Queued',
  connecting: 'Connecting',
  active: 'In progress',
  completed: 'Completed',
  failed: 'Failed',
  busy: 'Busy',
  no_answer: 'No answer',
  unknown: 'Check Exotel',
  configured: 'Configured',
  ready: 'Ready',
  missing: 'Setup needed',
  calling_disabled: 'Calling disabled',
};
export const badge = (value: string | null) =>
  `<span class="badge ${esc(value || 'pending')}"><span class="dot"></span>${esc(value ? (labels[value] ?? value) : 'Awaiting confirmation')}</span>`;
export const time = (date: string) =>
  new Date(date).toLocaleString('en-IN', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

export function transcriptHtml(items: { role: string; text: string }[]) {
  const turns: { role: string; text: string }[] = [];
  for (const item of items) {
    const last = turns.at(-1);
    if (last?.role === item.role) last.text += item.text;
    else turns.push({ ...item });
  }
  return turns
    .map(
      (t) =>
        `<div class="transcript-turn"><span>${t.role === 'agent' ? 'AGENT' : 'CUSTOMER'}</span><p>${esc(t.text)}</p></div>`,
    )
    .join('');
}
