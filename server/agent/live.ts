import type { Call } from '../../shared/domain.js';
import type { Store } from '../store.js';
import { GeminiAgent } from './gemini.js';
import { SarvamAgent } from './sarvam.js';
import type { VoiceOutput, VoiceAgent } from './voice.js';

export function createVoiceAgent(call: Call, store: Store, output: VoiceOutput): VoiceAgent {
  return (call.agentSettings ?? store.settings()).voiceProvider === 'sarvam'
    ? new SarvamAgent(call, store, output) : new GeminiAgent(call, store, output);
}
