import { outcomeSchema, type Call } from '../../shared/domain.js';
import type { Store } from '../store.js';
import type { VoiceOutput } from './voice.js';

export function quotesCustomer(customerText: string, evidence: string): boolean {
  const normalize = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[\s\p{P}]+/gu, ' ').trim();
  const quote = normalize(evidence);
  return quote.length >= 2 && normalize(customerText).includes(quote);
}

export function recordOutcome(call: Call, store: Store, customerText: string, value: unknown, output: Pick<VoiceOutput, 'outcome'>): Record<string, unknown> {
  const parsed = outcomeSchema.safeParse(value);
  if (!parsed.success) return { error: 'Invalid outcome. Ask the customer to clarify.' };
  if (!quotesCustomer(customerText, parsed.data.evidence)) {
    return { error: 'Evidence must quote actual customer speech. Ask for an explicit decision.' };
  }
  try {
    store.setOutcome(call.id, parsed.data.outcome, parsed.data.evidence);
    output.outcome();
    return { recorded: parsed.data.outcome, practice: call.mode === 'browser', externalOrderUpdated: false };
  } catch { return { error: 'Cannot record this decision. No order change was made.' }; }
}
