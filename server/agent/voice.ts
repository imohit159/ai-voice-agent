import type { Order, Settings } from '../../shared/domain.js';

export interface VoiceOutput {
  audio(data: string): void;
  interrupted(): void;
  turnComplete(hasOutcome: boolean): void;
  transcript(role: 'agent' | 'customer', text: string): void;
  outcome(): void;
  failure(message: string): void;
}
export interface VoiceAgent {
  connect(order: Order, settings: Settings): Promise<boolean>;
  audio(data: string): void;
  text(text: string): void;
  close(): void;
}
