import type { Call, Order, Settings, Transcript } from './domain.js';

export interface WorkspaceState {
  settings: Settings;
  orders: Order[];
  calls: Call[];
  connections: {
    geminiConfigured: boolean;
    sarvamConfigured: boolean;
    selectedConfigured: boolean;
    geminiModel: string;
    /** Provider credentials are validated at server start, so a running server is ready. */
    telephony: { provider: string; callerId: string | null };
    maxCallSeconds: number;
    maxConcurrentCalls: number;
  };
}

export interface StartCallRequest {
  orderId: string;
  mode: Call['mode'];
  requestKey: string;
}

export interface StartCallResponse {
  call: Call;
  token?: string;
}
export interface CallDetail {
  call: Call;
  transcript: Transcript[];
}
