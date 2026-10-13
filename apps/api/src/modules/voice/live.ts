import type { Call } from '@orderline/contracts';
import type { Store } from '../../platform/persistence/store.js';
import { GeminiAgent } from './providers/gemini.js';
import { SarvamAgent } from './providers/sarvam.js';
import type { VoiceOutput, VoiceAgent } from './voice.js';

export function createVoiceAgent(
  call: Call,
  store: Store,
  output: VoiceOutput,
): VoiceAgent {
  return (call.agentSettings ?? store.settings()).voiceProvider === 'sarvam'
    ? new SarvamAgent(call, store, output)
    : new GeminiAgent(call, store, output);
}
